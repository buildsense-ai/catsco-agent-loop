import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { CatscoAuthError, GithubAuthError, LoopError } from "./errors.js";
import type { ICatscoClient } from "./catsco-client.js";
import type { IGithubClient } from "./github-client.js";
import { developerPrompt, mondayFindingPrompt, mondayReviewPrompt, supplementPrompt } from "./prompts.js";
import { isTerminalPhase, RunStore } from "./store.js";
import type {
  AgentTurnState,
  CatscoFile,
  ControllerConfig,
  CreateRunInput,
  LoopRun,
  ReviewEvidence,
  RunPhase,
  SendMessageInput,
} from "./types.js";
import { validateFindingZip } from "./zip-validator.js";

const EPISODE_TERMINAL = new Set(["completed", "failed", "cancelled", "stale"]);
const RECOVERY_DELAYS = [60_000, 180_000, 480_000, 900_000];

function now(): string {
  return new Date().toISOString();
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14).toLowerCase();
  return `run_${stamp}_${randomBytes(4).toString("hex")}`;
}

function safeRepo(value: string): string {
  const repo = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  return repo;
}

function isZip(file: CatscoFile): boolean {
  return file.name.toLowerCase().endsWith(".zip") || file.mime_type?.toLowerCase().includes("zip") === true;
}

export class LoopController {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly validatedRepos = new Set<string>();
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor(
    readonly config: ControllerConfig,
    readonly store: RunStore,
    readonly catsco: ICatscoClient,
    readonly github: IGithubClient,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    try {
      await this.catsco.validateSession();
    } catch (error) {
      if (error instanceof CatscoAuthError) {
        for (const run of await this.store.listNonTerminal()) {
          this.rememberResumePhase(run);
          run.last_error = error.message;
          await this.transition(run, "blocked_auth", "none", "CatsCompany authentication", error.message);
        }
      } else {
        console.error("CatsCompany startup validation is degraded; API will remain available", error instanceof Error ? error.message : error);
      }
    }
    for (const run of await this.store.listNonTerminal()) {
      await this.store.appendEvent(run, { type: "controller_restarted", message: "Controller restarted; reconciliation is required before any resend." });
    }
  }

  startScheduler(): void {
    if (this.timer) return;
    const schedule = async () => {
      await this.tick().catch((error) => console.error("controller tick failed", error instanceof Error ? error.message : error));
       const active = await this.store.listNonTerminal();
       const delay = active.length
         ? Math.min(...active.map((run) => run.phase === "waiting_ci" ? this.config.githubPollMs : this.config.catscoPollMs))
         : this.config.idlePollMs;
       this.timer = setTimeout(schedule, delay);
      this.timer.unref();
    };
    this.timer = setTimeout(schedule, 0);
  }

  stopScheduler(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async createRun(input: CreateRunInput): Promise<LoopRun> {
    const request = input.request?.trim();
    if (!request) throw new Error("request is required");
    const repo = safeRepo(input.repo);
    const base = input.base_branch?.trim() || "main";
    if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) throw new Error("invalid base branch");
    const runId = makeRunId();
    const created = now();
    const run: LoopRun = {
      schema_version: 1,
      run_id: runId,
      phase: "queued",
      active_actor: "controller",
      waiting_for: "an available Controller execution slot",
      iteration: 0,
      monday_attempt: 0,
      developer_attempt: 0,
      recovery_attempt: 0,
      request,
      repo,
      base_branch: base,
      branch: `loop/${runId}`,
      monday_github_login: input.monday_github_login?.trim() || this.config.mondayGithubLogin,
      developer_github_login: input.developer_github_login?.trim() || this.config.developerGithubLogin,
      monday: { agent_uid: input.monday_agent_uid ?? this.config.mondayAgentUid, episode_started: false },
      developer: { agent_uid: input.developer_agent_uid ?? this.config.developerAgentUid, episode_started: false },
      review_baseline_comment_ids: [],
      sent_message_ids: [],
      receipts: {},
      created_at: created,
      updated_at: created,
      last_progress_at: created,
      cancel_requested: false,
    };
    if (run.monday_github_login.toLowerCase() === run.developer_github_login.toLowerCase()) {
      throw new Error("Monday and Developer GitHub logins must be different");
    }
    await this.store.initialize(run);
    await this.store.appendEvent(run, { type: "run_created", message: "Run created from explicit Controller input.", data: { repo, base_branch: base } });
    return run;
  }

  async cancel(runId: string): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (isTerminalPhase(run.phase)) return run;
      run.cancel_requested = true;
      return await this.transition(run, "cancelled", "none", "cancelled by operator", "Run cancelled. Sessions and GitHub resources were preserved.");
    });
  }

  async resume(runId: string): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (!["blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase)) return run;
      const reviewerAuthBlocked = Boolean(run.monday.github_auth_error);
      run.last_error = undefined;
      run.terminal_reason = undefined;
      run.paused_for_manual_message = undefined;
      run.next_retry_at = undefined;
      run.recovery_attempt = 0;
      // An explicit operator resume starts a fresh recovery window. Without
      // this, an old blocked Run can immediately trip the global stage timeout
      // before the resumed Agent Episode has a chance to start.
      run.last_progress_at = now();
      const phase = run.resume_phase ?? this.inferResumePhase(run);
      if (reviewerAuthBlocked && phase === "monday_review" && run.monday.topic_id) {
        run.monday.github_auth_error = undefined;
        // A Finding captured before reviewer credentials were restored is only
        // a partial delivery from the failed review attempt. Do not pair it
        // with a later review from the restored identity.
        run.pending_review_finding = undefined;
        run.monday_attempt += 1;
        await this.dispatch(run, run.monday, `monday-auth-resume-${run.monday_attempt}-${run.pr?.head_sha.slice(0, 8) ?? "nohead"}`, {
          topicId: run.monday.topic_id,
          clientMsgId: "",
          text: supplementPrompt(run, "Monday", `a ${run.monday_github_login} GitHub review on the current PR Head`),
        });
        return await this.transition(run, phase, this.actorFor(phase), `GitHub review by ${run.monday_github_login}`, "Reviewer credentials were marked restored; a fresh prompt was sent to the original Monday Topic.");
      }
      return await this.transition(run, phase, this.actorFor(phase), "manual reconciliation", "Operator resumed the existing Run; no new Topic was created.");
    });
  }

  async reconcile(runId: string): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (isTerminalPhase(run.phase) && !["blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase)) return run;
      return await this.process(run, true);
    });
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const runs = await this.store.listNonTerminal();
      const active = runs.filter((run) => run.phase !== "queued").slice(0, this.config.maxActiveRuns);
      const available = Math.max(0, this.config.maxActiveRuns - active.length);
      const selected = [...active, ...runs.filter((run) => run.phase === "queued").slice(0, available)];
      await Promise.all(selected.map(async (run) => await this.withRunLock(
        run.run_id,
        async () => await this.process(await this.store.readRun(run.run_id), false),
      )));
    } finally {
      this.ticking = false;
    }
  }

  private async process(run: LoopRun, forced: boolean): Promise<LoopRun> {
    try {
      if (run.cancel_requested) return await this.transition(run, "cancelled", "none", "cancelled by operator", "Run cancelled. Sessions and GitHub resources were preserved.");
      if (!forced && run.next_retry_at && Date.parse(run.next_retry_at) > Date.now()) return run;
      if (run.phase !== "queued" && Date.now() - Date.parse(run.last_progress_at) >= this.config.stageTimeoutMs) {
        return await this.block(run, `No mechanical progress for ${Math.round(this.config.stageTimeoutMs / 60_000)} minutes while waiting for ${run.waiting_for}.`);
      }
      if (!this.validatedRepos.has(run.repo)) {
        await this.github.validate(run.repo);
        this.validatedRepos.add(run.repo);
      }
      if (await this.detectManualMessage(run)) {
        this.rememberResumePhase(run);
        return await this.transition(run, "blocked", "none", "manual message detected", "A non-Controller human message entered a controlled Topic; Run paused to prevent double driving.");
      }
      if (run.pr && run.developer.protocol_error) {
        run.developer.protocol_error = undefined;
        await this.store.writeRun(run);
      }

      switch (run.phase) {
        case "queued": return await this.beginMonday(run);
        case "monday_finding": return await this.reconcileMondayFinding(run);
        case "developer_implementing": return await this.reconcileDeveloper(run, forced);
        case "waiting_ci": return await this.reconcileCi(run, forced);
        case "monday_review": return await this.reconcileMondayReview(run, forced);
        case "recovering": return await this.performRecovery(run, forced);
        case "blocked":
        case "blocked_auth":
        case "blocked_github_auth":
        case "cancelled":
        case "completed": return run;
      }
    } catch (error) {
      if (error instanceof CatscoAuthError) {
        this.rememberResumePhase(run);
        run.last_error = error.message;
        return await this.transition(run, "blocked_auth", "none", "CatsCompany authentication", error.message);
      }
      if (error instanceof GithubAuthError) {
        this.rememberResumePhase(run);
        run.last_error = error.message;
        return await this.transition(run, "blocked_github_auth", "none", "GitHub authentication", error.message);
      }
      run.last_error = error instanceof Error ? error.message : String(error);
      await this.store.appendEvent(run, { type: "reconcile_error", message: run.last_error, data: { retryable: error instanceof LoopError ? error.retryable : false } });
      run.updated_at = now();
      await this.store.writeRun(run);
      return run;
    }
  }

  private async beginMonday(run: LoopRun): Promise<LoopRun> {
    const taskName = `Loop ${run.run_id} · Monday`;
    const task = await this.catsco.findAgentTask(taskName, run.monday.agent_uid)
      ?? await this.catsco.createAgentTask(taskName, run.monday.agent_uid);
    run.monday.topic_id = task.topic;
    run.monday.group_id = task.group_id;
    run.monday_attempt += 1;
    await this.dispatch(run, run.monday, "monday-finding-0", { topicId: task.topic, clientMsgId: "", text: mondayFindingPrompt(run) });
    return await this.transition(run, "monday_finding", "monday", "validated Finding ZIP", "Monday Agent Task created and initial finding request sent.");
  }

  private async reconcileMondayFinding(run: LoopRun): Promise<LoopRun> {
    await this.refreshAgent(run, run.monday);
    const finding = await this.findAndStoreFinding(run, run.monday, run.latest_finding?.source_message_id ?? 0);
    if (finding) {
      run.latest_finding = finding;
      const taskName = `Loop ${run.run_id} · Developer`;
      const task = run.developer.topic_id ? undefined : await this.catsco.findAgentTask(taskName, run.developer.agent_uid)
        ?? await this.catsco.createAgentTask(taskName, run.developer.agent_uid);
      if (task) {
        run.developer.topic_id = task.topic;
        run.developer.group_id = task.group_id;
      }
      if (!run.developer.topic_id) throw new Error("Developer Topic is unavailable");
      run.developer_attempt += 1;
      await this.dispatch(run, run.developer, `developer-initial-${run.iteration}`, {
        topicId: run.developer.topic_id,
        clientMsgId: "",
        text: developerPrompt(run, "initial"),
        files: [{ name: finding.name, url: finding.url, mimeType: "application/zip", size: finding.size }],
      });
      return await this.transition(run, "developer_implementing", "developer", `open PR on ${run.branch}`, "Finding ZIP validated and handed to Developer in a dedicated Agent Task.");
    }
    return await this.recoverIfTerminal(run, run.monday, "Monday", "a downloadable ZIP containing FINDING.md and manifest.json");
  }

  private async reconcileDeveloper(run: LoopRun, forced = false): Promise<LoopRun> {
    await this.refreshAgent(run, run.developer);
    if (run.developer.protocol_error && run.developer.episode_started && run.developer.episode && EPISODE_TERMINAL.has(run.developer.episode.state)) {
      return await this.block(run, run.developer.protocol_error);
    }
    const terminalEpisode = Boolean(run.developer.episode_started && run.developer.episode && EPISODE_TERMINAL.has(run.developer.episode.state));
    if (!await this.beginGithubPoll(run, forced || terminalEpisode)) return run;
    const pull = await this.github.findPullRequest(run.repo, run.branch, run.base_branch);
    if (pull) {
      const identityError = this.pullIdentityError(run, pull);
      if (identityError) return await this.block(run, identityError);
    }
    const expected = run.pr?.expected_previous_sha;
    if (pull && (!expected || pull.head_sha !== expected)) {
      pull.first_seen_at = run.pr?.first_seen_at ?? pull.first_seen_at;
      if (expected) pull.expected_previous_sha = expected;
      run.pr = pull;
      run.ci = undefined;
      await this.progress(run, "github_delivery", `Detected PR #${pull.number} at Head ${pull.head_sha}.`, { pr: pull.number, sha: pull.head_sha });
      return await this.transition(run, "waiting_ci", "github", `CI for ${pull.head_sha}`, "Developer GitHub delivery verified mechanically.");
    }
    const missing = run.pr ? `a new Head SHA on existing PR #${run.pr.number}` : `an open PR from ${run.branch} to ${run.base_branch}`;
    return await this.recoverIfTerminal(run, run.developer, "Developer", missing);
  }

  private async reconcileCi(run: LoopRun, forced = false): Promise<LoopRun> {
    if (!run.pr) return await this.transition(run, "developer_implementing", "developer", "an open PR", "PR state was missing; returning to Developer reconciliation.");
    if (!await this.beginGithubPoll(run, forced)) return run;
    const current = await this.github.findPullRequest(run.repo, run.branch, run.base_branch);
    if (!current) return await this.block(run, "Tracked PR is no longer open or no longer matches the required branch/base.");
    const identityError = this.pullIdentityError(run, current);
    if (identityError) return await this.block(run, identityError);
    if (current.head_sha !== run.pr.head_sha) {
      run.pr = { ...current, first_seen_at: run.pr.first_seen_at };
      run.ci = undefined;
      await this.progress(run, "head_changed", `PR Head changed to ${current.head_sha}; old approval and CI are invalid.`, { sha: current.head_sha });
    }
    const previousCiState = run.ci?.state;
    run.ci = await this.github.getCi(run.repo, run.pr.head_sha, run.ci);
    if (run.ci.state !== "pending" && run.ci.state !== previousCiState) {
      await this.progress(run, "ci_observed", `CI reached ${run.ci.state} for ${run.pr.head_sha}.`, { sha: run.pr.head_sha, state: run.ci.state });
    } else {
      run.updated_at = now();
      await this.store.writeRun(run);
    }
    if (run.ci.state === "pending") return run;
    if (run.ci.state === "failure") {
      const detail = run.ci.checks.filter((check) => ["failure", "cancelled", "timed_out", "action_required", "stale", "error"].includes((check.conclusion ?? "").toLowerCase()))
        .map((check) => `${check.name}: ${check.conclusion}${check.url ? ` ${check.url}` : ""}`).join("\n");
      run.pr.expected_previous_sha = run.pr.head_sha;
      run.developer_attempt += 1;
      await this.dispatch(run, run.developer, `developer-ci-${run.developer_attempt}-${run.pr.head_sha.slice(0, 8)}`, {
        topicId: run.developer.topic_id!, clientMsgId: "", text: developerPrompt(run, "ci", detail || "CI failed."),
      });
      return await this.transition(run, "developer_implementing", "developer", "new Head SHA fixing CI", "CI failure returned to the same Developer Topic; Controller did not rerun CI.");
    }
    const evidence = await this.github.getReviewEvidence(run.repo, run.pr.number);
    run.review_baseline_comment_ids = evidence.map((item) => item.id);
    run.review_requested_at = now();
    run.monday_attempt += 1;
    await this.dispatch(run, run.monday, `monday-review-${run.iteration}-${run.pr.head_sha.slice(0, 8)}`, {
      topicId: run.monday.topic_id!, clientMsgId: "", text: mondayReviewPrompt(run),
    });
    run.review_dispatch_seq = run.monday.dispatch_seq;
    return await this.transition(run, "monday_review", "monday", "current-SHA approval or comment plus new Finding ZIP", `CI ${run.ci.state}; review request sent to the original Monday Topic.`);
  }

  private async reconcileMondayReview(run: LoopRun, forced = false): Promise<LoopRun> {
    if (!run.pr) return await this.block(run, "Monday review phase has no tracked PR.");
    await this.refreshAgent(run, run.monday);
    const terminalEpisode = Boolean(run.monday.episode_started && run.monday.episode && EPISODE_TERMINAL.has(run.monday.episode.state));
    if (!await this.beginGithubPoll(run, forced || terminalEpisode || Boolean(run.monday.github_auth_error))) return run;
    const current = await this.github.findPullRequest(run.repo, run.branch, run.base_branch);
    if (!current) return await this.block(run, "Tracked PR is no longer open during Monday review.");
    const identityError = this.pullIdentityError(run, current);
    if (identityError) return await this.block(run, identityError);
    if (current.head_sha !== run.pr.head_sha) {
      run.pr = { ...current, first_seen_at: run.pr.first_seen_at };
      run.ci = undefined;
      return await this.transition(run, "waiting_ci", "github", `CI for unexpected new SHA ${current.head_sha}`, "Head changed during review; previous approval is invalid.");
    }
    const evidence = await this.github.getReviewEvidence(run.repo, run.pr.number);
    const monday = run.monday_github_login.toLowerCase();
    const authored = evidence.filter((item) => item.author.toLowerCase() === monday);
    const approval = authored.filter((item) => item.kind === "review" && item.state?.toUpperCase() === "APPROVED" && item.commit_id === run.pr!.head_sha)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (approval && (run.ci?.state === "success" || run.ci?.state === "none")) {
      run.terminal_reason = `Approved by ${approval.author} on current Head ${run.pr.head_sha}`;
      return await this.transition(run, "completed", "none", "nothing; approval is terminal", "Current SHA received a valid Monday APPROVED review. PR remains open and unmerged.");
    }
    const baseline = new Set(run.review_baseline_comment_ids);
    const newComment = authored.find((item) => !baseline.has(item.id) && this.isChangeEvidence(item, run));
    let newFinding = run.pending_review_finding;
    if (!newFinding) {
      newFinding = await this.findAndStoreFinding(run, run.monday, run.latest_finding?.source_message_id ?? 0);
      if (newFinding) {
        run.pending_review_finding = newFinding;
        await this.store.writeRun(run);
      }
    }
    if (newComment && newFinding) {
      run.latest_finding = newFinding;
      run.pending_review_finding = undefined;
      run.iteration += 1;
      run.pr.expected_previous_sha = run.pr.head_sha;
      run.developer_attempt += 1;
      await this.dispatch(run, run.developer, `developer-revision-${run.iteration}`, {
        topicId: run.developer.topic_id!, clientMsgId: "", text: developerPrompt(run, "revision", `Monday review evidence: ${newComment.url ?? newComment.id}`),
        files: [{ name: newFinding.name, url: newFinding.url, mimeType: "application/zip", size: newFinding.size }],
      });
      return await this.transition(run, "developer_implementing", "developer", "new Head SHA on the same PR", "Monday comment/review and new Finding ZIP were both verified and handed to the original Developer Topic.");
    }
    if (run.monday.github_auth_error) {
      this.rememberResumePhase(run);
      run.last_error = run.monday.github_auth_error;
      return await this.transition(run, "blocked_github_auth", "none", `GitHub reviewer identity ${run.monday_github_login}`, run.monday.github_auth_error);
    }
    const missing = newComment ? "a new validated Finding ZIP" : newFinding ? "a Monday GitHub review/comment on the current PR Head" : "either current-SHA APPROVED, or both a GitHub review/comment and new Finding ZIP";
    return await this.recoverIfTerminal(run, run.monday, "Monday", missing);
  }

  private isChangeEvidence(item: ReviewEvidence, run: LoopRun): boolean {
    if (item.kind === "review" && item.state?.toUpperCase() === "APPROVED") return false;
    if (item.commit_id && item.commit_id !== run.pr?.head_sha) return false;
    return !run.review_requested_at || item.created_at >= run.review_requested_at;
  }

  private pullIdentityError(run: LoopRun, pull: NonNullable<LoopRun["pr"]>): string | undefined {
    if (pull.author_login.toLowerCase() !== run.developer_github_login.toLowerCase()) {
      return `PR #${pull.number} author ${pull.author_login || "<unknown>"} does not match configured Developer identity ${run.developer_github_login}.`;
    }
    if (pull.head_repository.toLowerCase() !== run.repo.toLowerCase()) {
      return `PR #${pull.number} head repository ${pull.head_repository || "<unknown>"} does not match controlled repository ${run.repo}.`;
    }
    return undefined;
  }

  private async beginGithubPoll(run: LoopRun, forced: boolean): Promise<boolean> {
    if (!forced && run.github_poll_phase === run.phase && run.github_polled_at && Date.now() - Date.parse(run.github_polled_at) < this.config.githubPollMs) return false;
    run.github_polled_at = now();
    run.github_poll_phase = run.phase;
    await this.store.writeRun(run);
    return true;
  }

  private async refreshAgent(run: LoopRun, agent: AgentTurnState): Promise<void> {
    if (!agent.topic_id) return;
    const [episode, messages] = await Promise.all([
      this.catsco.getEpisode(agent.topic_id),
      this.catsco.getMessagesAfter(agent.topic_id, agent.dispatch_seq ?? 0),
    ]);
    agent.episode = episode;
    agent.episode_observed_at = now();
    const response = messages.filter((message) => message.from_uid === agent.agent_uid && message.id > (agent.dispatch_seq ?? 0)).at(-1);
    if (response) {
      agent.last_agent_seq = response.id;
      const text = typeof response.content === "string" ? response.content : "";
      const strictWorkerRefusal = /(?:missing|缺少|未收到)[\s\S]{0,600}(?:LOOP_WORKTREE_CONTRACT_V1|execute_attempt|workspaceLease|targetTopicId)/i.test(text)
        && /(?:cannot|can't|refus|不能|无法)[\s\S]{0,600}(?:execute|proceed|create|push|执行|创建|推送|进入)/i.test(text);
      if (agent === run.developer && strictWorkerRefusal) {
        agent.protocol_error = "Selected Developer is a strict execute_attempt worker and cannot accept direct-prompt Loop tasks. Choose a direct-capable Developer Agent or integrate the separate native A2A Harness.";
      }
      if (agent === run.monday) {
        const marker = `LOOP_BLOCKED_GITHUB_AUTH reviewer=${run.monday_github_login}`;
        const exactMarker = text.split(/\r?\n/).some((line) => line.trim() === marker);
        const directAgentDelivery = !/^Command (?:completed|failed|timed out)\b/i.test(text.trim());
        const explicitUnavailable = text.includes(run.monday_github_login)
          && /(?:credential|凭据|身份)[\s\S]{0,120}(?:unavailable|missing|未提供|不可用|无法)/i.test(text);
        if (exactMarker || (directAgentDelivery && explicitUnavailable)) {
          agent.github_auth_error = `Required Monday GitHub reviewer identity ${run.monday_github_login} is unavailable; Run and PR were preserved for operator recovery.`;
        }
      }
    }
    agent.episode_started = Boolean(
      response || (episode?.run_id && episode.run_id !== agent.previous_episode_run_id),
    );
    run.updated_at = now();
    await this.store.writeRun(run);
  }

  private async findAndStoreFinding(run: LoopRun, agent: AgentTurnState, afterMessageId: number): Promise<LoopRun["latest_finding"] | undefined> {
    if (!agent.topic_id) return undefined;
    const files = await this.catsco.getAgentFiles(agent.agent_uid, agent.topic_id);
    const candidates = files.filter((file) => file.message_id > Math.max(agent.dispatch_seq ?? 0, afterMessageId) && isZip(file)).sort((a, b) => b.message_id - a.message_id);
    for (const file of candidates) {
      const version = Math.max(run.latest_finding?.version ?? 0, run.pending_review_finding?.version ?? 0) + 1;
      const destination = await this.store.findingPath(run.run_id, version);
      try {
        const downloaded = await this.catsco.download(file.url, destination, this.config.maxFindingBytes);
        await validateFindingZip(destination);
        const finding = {
          version,
          id: file.id,
          name: basename(file.name),
          url: file.url,
          source_message_id: file.message_id,
          source_topic_id: file.topic_id,
          size: downloaded.size,
          sha256: downloaded.sha256,
          stored_path: destination,
          ...(file.created_at ? { created_at: file.created_at } : {}),
          validated_at: now(),
        };
        await this.progress(run, "finding_validated", `Validated Finding ZIP v${version}.`, { file_id: file.id, sha256: downloaded.sha256, size: downloaded.size });
        return finding;
      } catch (error) {
        await this.store.appendEvent(run, { type: "finding_rejected", message: error instanceof Error ? error.message : String(error), data: { file_id: file.id, message_id: file.message_id } });
      }
    }
    return undefined;
  }

  private async dispatch(run: LoopRun, agent: AgentTurnState, action: string, input: SendMessageInput): Promise<void> {
    const key = `${run.run_id}:${action}`;
    const existing = run.receipts[key];
    if (existing) return;
    const previous = agent.topic_id ? await this.catsco.getEpisode(agent.topic_id) : undefined;
    input.clientMsgId = key;
    const receipt = await this.catsco.sendMessage(input);
    const sentAt = now();
    run.receipts[key] = {
      key, topic_id: input.topicId, message_id: receipt.id, seq_id: receipt.seq_id, client_msg_id: key, sent_at: sentAt,
    };
    run.sent_message_ids.push(receipt.id);
    agent.dispatch_seq = receipt.seq_id;
    agent.dispatch_message_id = receipt.id;
    agent.previous_episode_run_id = previous?.run_id;
    agent.episode = previous;
    agent.episode_started = false;
    agent.last_prompt_key = key;
    agent.last_observed_seq = Math.max(agent.last_observed_seq ?? 0, receipt.seq_id);
    agent.protocol_error = undefined;
    agent.github_auth_error = undefined;
    run.updated_at = sentAt;
    await this.store.writeRun(run);
    await this.store.appendEvent(run, { type: "message_dispatched", message: `Idempotent message dispatched to ${input.topicId}.`, data: { action, message_id: receipt.id, duplicate: receipt.duplicate ?? false } });
  }

  private async recoverIfTerminal(run: LoopRun, agent: AgentTurnState, role: "Monday" | "Developer", missing: string): Promise<LoopRun> {
    const episode = agent.episode;
    if (!agent.episode_started || !episode || !EPISODE_TERMINAL.has(episode.state)) return run;
    if (Date.now() - Date.parse(run.last_progress_at) >= this.config.stageTimeoutMs) return await this.block(run, `No mechanical progress for 45 minutes; still missing ${missing}.`);
    if (run.recovery_attempt >= RECOVERY_DELAYS.length) return await this.block(run, `Recovery attempts exhausted; still missing ${missing}.`);
    run.resume_phase = run.phase as Exclude<RunPhase, "recovering">;
    run.next_retry_at = new Date(Date.now() + RECOVERY_DELAYS[run.recovery_attempt]!).toISOString();
    run.waiting_for = `${missing}; recovery scheduled`;
    run.last_error = episode.error || `Episode ${episode.state} without complete delivery`;
    return await this.transition(run, "recovering", "controller", run.waiting_for, `Episode ${episode.state}; reconciled side effects first and scheduled bounded recovery.`);
  }

  private async performRecovery(run: LoopRun, forced = false): Promise<LoopRun> {
    if (!run.next_retry_at || (!forced && Date.parse(run.next_retry_at) > Date.now())) return run;
    const phase = run.resume_phase;
    if (!phase) return await this.block(run, "Recovery phase lost its resume target.");
    run.phase = phase;
    run.recovery_attempt += 1;
    run.next_retry_at = undefined;
    if (phase === "monday_finding" || phase === "monday_review") {
      const missing = phase === "monday_finding" ? "a validated Finding ZIP" : run.waiting_for.replace(/; recovery scheduled$/, "");
      run.monday_attempt += 1;
      await this.dispatch(run, run.monday, `recovery-monday-${phase}-${run.monday_attempt}-${run.iteration}`, {
        topicId: run.monday.topic_id!, clientMsgId: "", text: supplementPrompt(run, "Monday", missing),
      });
    } else if (phase === "developer_implementing") {
      const missing = run.waiting_for.replace(/; recovery scheduled$/, "");
      run.developer_attempt += 1;
      await this.dispatch(run, run.developer, `recovery-developer-${run.developer_attempt}-${run.iteration}`, {
        topicId: run.developer.topic_id!, clientMsgId: "", text: supplementPrompt(run, "Developer", missing),
      });
    }
    return await this.transition(run, phase, this.actorFor(phase), run.waiting_for.replace(/; recovery scheduled$/, ""), "Recovery prompt sent to the original Topic after reconciliation.");
  }

  private async detectManualMessage(run: LoopRun): Promise<boolean> {
    for (const agent of [run.monday, run.developer]) {
      if (!agent.topic_id) continue;
      const messages = await this.catsco.getMessagesAfter(agent.topic_id, agent.last_observed_seq ?? 0);
      const manual = messages.find((message) => message.from_uid !== agent.agent_uid && !run.sent_message_ids.includes(message.id));
      const newest = messages.at(-1);
      if (newest) agent.last_observed_seq = Number(newest.seq_id ?? newest.id);
      if (manual) {
        run.paused_for_manual_message = { topic_id: agent.topic_id, message_id: manual.id, detected_at: now() };
        await this.store.writeRun(run);
        return true;
      }
    }
    return false;
  }

  private inferResumePhase(run: LoopRun): Exclude<RunPhase, "recovering"> {
    if (!run.monday.topic_id) return "queued";
    if (!run.latest_finding) return "monday_finding";
    if (!run.developer.topic_id || !run.pr) return "developer_implementing";
    if (!run.ci || run.ci.sha !== run.pr.head_sha || run.ci.state === "pending") return "waiting_ci";
    return "monday_review";
  }

  private actorFor(phase: RunPhase): LoopRun["active_actor"] {
    if (phase === "monday_finding" || phase === "monday_review") return "monday";
    if (phase === "developer_implementing") return "developer";
    if (phase === "waiting_ci") return "github";
    return "controller";
  }

  private async block(run: LoopRun, reason: string): Promise<LoopRun> {
    this.rememberResumePhase(run);
    run.terminal_reason = reason;
    return await this.transition(run, "blocked", "none", "operator intervention", reason);
  }

  private rememberResumePhase(run: LoopRun): void {
    if (run.phase !== "recovering") run.resume_phase = run.phase as Exclude<RunPhase, "recovering">;
  }

  private async withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(action);
    const barrier = task.then(() => undefined, () => undefined);
    this.runLocks.set(runId, barrier);
    try {
      return await task;
    } finally {
      if (this.runLocks.get(runId) === barrier) this.runLocks.delete(runId);
    }
  }

  private async progress(run: LoopRun, type: string, message: string, data?: Record<string, unknown>): Promise<void> {
    run.last_progress_at = now();
    run.updated_at = run.last_progress_at;
    run.recovery_attempt = 0;
    run.next_retry_at = undefined;
    await this.store.writeRun(run);
    await this.store.appendEvent(run, { type, message, ...(data ? { data } : {}) });
  }

  private async transition(run: LoopRun, phase: RunPhase, actor: LoopRun["active_actor"], waitingFor: string, message: string): Promise<LoopRun> {
    const previous = run.phase;
    run.phase = phase;
    run.active_actor = actor;
    run.waiting_for = waitingFor;
    run.updated_at = now();
    await this.store.writeRun(run);
    await this.store.appendEvent(run, { type: "phase_changed", message, data: { from: previous, to: phase, waiting_for: waitingFor } });
    return run;
  }
}
