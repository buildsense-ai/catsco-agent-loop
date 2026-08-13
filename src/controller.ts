import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { activityAgent, computeActivityState } from "./activity.js";
import { CatscoAuthError, GithubAuthError, LoopError } from "./errors.js";
import type { ICatscoClient } from "./catsco-client.js";
import type { IGithubClient } from "./github-client.js";
import { developerPrompt, mondayFindingPrompt, mondayReviewPrompt, supplementPrompt, unstartedResumePrompt } from "./prompts.js";
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

function safeIdempotencyKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key) return undefined;
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error("invalid idempotency key");
  return createHash("sha256").update(key).digest("hex");
}

function creationFingerprint(request: string, repo: string, baseBranch?: string): string {
  return createHash("sha256").update(JSON.stringify({ request, repo, base_branch: baseBranch?.trim() || null })).digest("hex");
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
    await this.store.migrateLegacyRuns();
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
    const idempotencyKey = safeIdempotencyKey(input.idempotency_key);
    const fingerprint = creationFingerprint(request, repo, input.base_branch);
    if (idempotencyKey) {
      const existing = await this.store.readCreationReceipt(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new LoopError("idempotency key was already used for a different request", "idempotency_conflict", false, 409);
        return await this.store.readRun(existing.run_id);
      }
    }
    const base = input.base_branch?.trim() || await this.github.getDefaultBranch(repo);
    if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) throw new Error("invalid base branch");
    const runId = makeRunId();
    const created = now();
    const run: LoopRun = {
      schema_version: 2,
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
      finding_history: [],
      review_cycles: [],
      review_baseline_comment_ids: [],
      review_progress_evidence_ids: [],
      sent_message_ids: [],
      receipts: {},
      created_at: created,
      updated_at: created,
      phase_started_at: created,
      activity_state: "quiet",
      last_activity_at: created,
      last_progress_at: created,
      cancel_requested: false,
    };
    if (run.monday_github_login.toLowerCase() === run.developer_github_login.toLowerCase()) {
      throw new Error("Monday and Developer GitHub logins must be different");
    }
    await this.store.initialize(run);
    if (idempotencyKey) {
      try {
        await this.store.writeCreationReceipt({ key: idempotencyKey, fingerprint, run_id: run.run_id, created_at: created });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.store.readCreationReceipt(idempotencyKey);
        if (!existing || existing.fingerprint !== fingerprint) {
          await this.store.removeRun(run.run_id);
          throw new LoopError("idempotency key was already used for a different request", "idempotency_conflict", false, 409);
        }
        await this.store.removeRun(run.run_id);
        return await this.store.readRun(existing.run_id);
      }
    }
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

  async pause(runId: string): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (isTerminalPhase(run.phase) || run.phase === "paused") return run;
      this.rememberResumePhase(run);
      run.next_retry_at = undefined;
      return await this.transition(run, "paused", "none", "operator resume", "Run softly paused by operator. No Agent message was sent and external work was preserved.");
    });
  }

  async reassignDeveloper(runId: string, agentUid: number): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (!["paused", "blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase)) {
        throw new LoopError("Developer can only be reassigned while the Run is paused or blocked", "developer_reassignment", false, 409);
      }
      if (run.pr) throw new LoopError("Developer cannot be reassigned after a PR has been detected", "developer_reassignment", false, 409);
      if (!run.latest_finding) throw new LoopError("Developer cannot be reassigned before the initial Finding ZIP", "developer_reassignment", false, 409);
      if (!Number.isSafeInteger(agentUid) || agentUid <= 0) throw new LoopError("agent_uid must be a positive integer", "developer_reassignment", false, 400);
      if (agentUid === run.developer.agent_uid) return run;

      const previous = { agent_uid: run.developer.agent_uid, topic_id: run.developer.topic_id };
      const taskName = `Loop ${run.run_id} 路 Developer`;
      const task = await this.catsco.findAgentTask(taskName, agentUid)
        ?? await this.catsco.createAgentTask(taskName, agentUid);
      run.developer = { agent_uid: agentUid, topic_id: task.topic, group_id: task.group_id, episode_started: false };
      run.developer_attempt += 1;
      run.recovery_attempt = 0;
      run.last_error = undefined;
      run.terminal_reason = undefined;
      run.next_retry_at = undefined;
      const finding = run.latest_finding;
      await this.store.appendEvent(run, {
        type: "developer_reassigned",
        message: `Developer reassigned from UID ${previous.agent_uid} to UID ${agentUid}; prior Topic was preserved as history.`,
        data: { previous, current: { agent_uid: agentUid, topic_id: task.topic } },
      });
      await this.dispatch(run, run.developer, `developer-reassigned-${agentUid}-${run.developer_attempt}-${run.iteration}`, {
        topicId: task.topic,
        clientMsgId: "",
        text: developerPrompt(run, "initial"),
        files: [{ name: finding.name, url: finding.url, mimeType: "application/zip", size: finding.size }],
      });
      return await this.transition(run, "developer_implementing", "developer", `open PR on ${run.branch}`, "Existing Finding ZIP handed to the reassigned Developer in a new Agent Task.");
    });
  }

  async resume(runId: string): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (!["paused", "blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase)) return run;
      const blockedWithoutEpisodeStart = run.phase === "blocked" && /No mechanical progress/i.test(run.terminal_reason ?? "");
      const reviewerAuthBlocked = Boolean(run.monday.github_auth_error);
      const developerProtocolBlocked = Boolean(run.developer.protocol_error);
      run.last_error = undefined;
      run.terminal_reason = undefined;
      run.paused_for_manual_message = undefined;
      run.next_retry_at = undefined;
      run.recovery_attempt = 0;
      // An explicit operator resume starts fresh activity and mechanical
      // waiting windows while preserving created_at as the absolute-cap anchor.
      const resumedAt = now();
      run.last_activity_at = resumedAt;
      run.last_progress_at = resumedAt;
      const phase = run.resume_phase ?? this.inferResumePhase(run);
      if (developerProtocolBlocked && phase === "developer_implementing" && run.developer.topic_id) {
        // The operator may resume after the Controller's direct-task contract
        // has been upgraded. Archive the stale refusal and explicitly wake the
        // same Topic with the current contract; do not silently loop retries.
        run.developer.protocol_error = undefined;
        run.developer_attempt += 1;
        await this.dispatch(run, run.developer, `developer-protocol-resume-${run.developer_attempt}-${run.iteration}`, {
          topicId: run.developer.topic_id,
          clientMsgId: "",
          text: supplementPrompt(run, "Developer", run.pr
            ? `a new Head SHA on existing PR #${run.pr.number}`
            : `an open PR from ${run.branch} to ${run.base_branch}`),
        });
        return await this.transition(run, phase, this.actorFor(phase), run.pr
          ? `a new Head SHA on existing PR #${run.pr.number}`
          : `an open PR from ${run.branch} to ${run.base_branch}`,
        "Operator explicitly retried the original Developer Topic with the current direct-task contract.");
      }
      if (reviewerAuthBlocked && phase === "monday_review" && run.monday.topic_id) {
        run.monday.github_auth_error = undefined;
        // Preserve the failed attempt as a completed historical cycle, then
        // start a clean cycle so its ZIP cannot pair with later GitHub evidence.
        const cycle = await this.startReviewCycle(run, "Reviewer credentials were restored; prior partial delivery was archived.");
        run.monday_attempt += 1;
        await this.dispatch(run, run.monday, `monday-auth-resume-cycle-${cycle.cycle}-${run.pr?.head_sha.slice(0, 8) ?? "nohead"}`, {
          topicId: run.monday.topic_id,
          clientMsgId: "",
          text: supplementPrompt(run, "Monday", `a ${run.monday_github_login} GitHub review on the current PR Head`),
        });
        run.review_dispatch_seq = run.monday.dispatch_seq;
        cycle.dispatch_seq = run.monday.dispatch_seq;
        return await this.transition(run, phase, this.actorFor(phase), `GitHub review by ${run.monday_github_login}`, "Reviewer credentials were marked restored; a fresh prompt was sent to the original Monday Topic.");
      }
      const resumedAgent = phase === "monday_finding" || phase === "monday_review"
        ? run.monday
        : phase === "developer_implementing"
          ? run.developer
          : undefined;
      if (blockedWithoutEpisodeStart && resumedAgent?.topic_id && !resumedAgent.episode_started) {
        const role = resumedAgent === run.monday ? "Monday" : "Developer";
        const missing = phase === "monday_finding" ? "a validated Finding ZIP" : run.waiting_for || "the current mechanical delivery";
        if (role === "Monday") run.monday_attempt += 1;
        else run.developer_attempt += 1;
        await this.dispatch(run, resumedAgent, `operator-resume-unstarted-${role.toLowerCase()}-${role === "Monday" ? run.monday_attempt : run.developer_attempt}-${run.iteration}`, {
          topicId: resumedAgent.topic_id,
          clientMsgId: "",
          text: unstartedResumePrompt(run, role, missing),
        });
        return await this.transition(run, phase, this.actorFor(phase), missing, "Operator resumed an unstarted Agent delivery with a structured wake in the original Topic.");
      }
      return await this.transition(run, phase, this.actorFor(phase), "manual reconciliation", "Operator resumed the existing Run; no new Topic was created.");
    });
  }

  async reconcile(runId: string): Promise<LoopRun> {
    return await this.withRunLock(runId, async () => {
      const run = await this.store.readRun(runId);
      if (isTerminalPhase(run.phase) && !["blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase)) return run;
      const phase = run.phase;
      const reconciled = await this.process(run, true);
      if (reconciled.phase !== phase || isTerminalPhase(reconciled.phase)) return reconciled;
      return await this.wakeExplicitlyReconciledStall(reconciled);
    });
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const runs = await this.store.listNonTerminal();
      const expired = runs.filter((run) => run.phase !== "paused" && this.absoluteTimeoutReached(run));
      const active = runs.filter((run) => run.phase !== "queued" && run.phase !== "paused").slice(0, this.config.maxActiveRuns);
      const available = Math.max(0, this.config.maxActiveRuns - active.length);
      const queued = runs.filter((run) => run.phase === "queued" && !this.absoluteTimeoutReached(run)).slice(0, available);
      const selected = [...new Map([...expired, ...active, ...queued].map((run) => [run.run_id, run])).values()];
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
      if (!isTerminalPhase(run.phase) && this.absoluteTimeoutReached(run)) {
        return await this.block(run, `Run exceeded the absolute limit of ${Math.round(this.config.runAbsoluteTimeoutMs / 60_000)} minutes.`);
      }
      if (!forced && run.next_retry_at && Date.parse(run.next_retry_at) > Date.now()) {
        if (await this.detectManualMessage(run)) {
          this.rememberResumePhase(run);
          return await this.transition(run, "blocked", "none", "manual message detected", "A non-Controller human message entered a controlled Topic; Run paused to prevent double driving.");
        }
        const waitingAgent = activityAgent(run);
        if (waitingAgent) await this.refreshAgent(run, waitingAgent);
        await this.updateActivityState(run);
        return run;
      }
      if (!this.validatedRepos.has(run.repo)) {
        await this.github.validate(run.repo);
        this.validatedRepos.add(run.repo);
      }
      if (await this.detectManualMessage(run)) {
        this.rememberResumePhase(run);
        return await this.transition(run, "blocked", "none", "manual message detected", "A non-Controller human message entered a controlled Topic; Run paused to prevent double driving.");
      }
      const agent = activityAgent(run);
      if (agent) await this.refreshAgent(run, agent);
      await this.updateActivityState(run);
      if (run.phase !== "queued" && this.mechanicalTimeoutReached(run) && this.mechanicalTimeoutCanBlock(run)) {
        return await this.block(run, `No mechanical progress for ${Math.round(this.config.stageTimeoutMs / 60_000)} minutes while waiting for ${run.waiting_for}.`);
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
        case "paused": return run;
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

  private async reconcileMondayFinding(run: LoopRun, allowRecovery = true): Promise<LoopRun> {
    const finding = await this.findAndStoreFinding(run, run.monday, run.latest_finding?.source_message_id ?? 0, { purpose: "initial" });
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
    const missing = "a downloadable ZIP containing FINDING.md and manifest.json";
    if (allowRecovery) return await this.recoverIfTerminal(run, run.monday, "Monday", missing);
    run.waiting_for = missing;
    await this.store.writeRun(run);
    return run;
  }

  private async reconcileDeveloper(run: LoopRun, forced = false, allowRecovery = true): Promise<LoopRun> {
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
    if (allowRecovery) return await this.recoverIfTerminal(run, run.developer, "Developer", missing);
    run.waiting_for = missing;
    await this.store.writeRun(run);
    return run;
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
    const cycle = await this.startReviewCycle(run, "CI completed; Monday review requested.");
    run.monday_attempt += 1;
    await this.dispatch(run, run.monday, `monday-review-cycle-${cycle.cycle}-${run.pr.head_sha.slice(0, 8)}`, {
      topicId: run.monday.topic_id!, clientMsgId: "", text: mondayReviewPrompt(run),
    });
    run.review_dispatch_seq = run.monday.dispatch_seq;
    cycle.dispatch_seq = run.monday.dispatch_seq;
    return await this.transition(run, "monday_review", "monday", "current-SHA approval or comment plus new Finding ZIP", `CI ${run.ci.state}; review request sent to the original Monday Topic.`);
  }

  private async startReviewCycle(run: LoopRun, reason: string): Promise<NonNullable<LoopRun["review_cycle"]>> {
    if (!run.pr) throw new Error("Cannot start a review cycle without a tracked PR");
    this.finishReviewCycle(run, "superseded", undefined, reason);
    const evidence = await this.github.getReviewEvidence(run.repo, run.pr.number);
    const requestedAt = now();
    const cycle = {
      cycle: Math.max(0, ...run.review_cycles.map((item) => item.cycle)) + 1,
      pr_number: run.pr.number,
      head_sha: run.pr.head_sha,
      requested_at: requestedAt,
      baseline_evidence_ids: evidence.map((item) => item.id),
      status: "active" as const,
    };
    run.review_cycle = cycle;
    run.review_cycles.push(cycle);
    // Keep the original top-level fields as current-cycle compatibility aliases.
    run.review_baseline_comment_ids = [...cycle.baseline_evidence_ids];
    run.review_requested_at = requestedAt;
    run.review_dispatch_seq = undefined;
    run.pending_review_finding = undefined;
    await this.store.writeRun(run);
    await this.store.appendEvent(run, {
      type: "review_cycle_started",
      message: `Review cycle ${cycle.cycle} started for PR #${cycle.pr_number} at Head ${cycle.head_sha}.`,
      data: { review_cycle: cycle.cycle, pr: cycle.pr_number, head_sha: cycle.head_sha },
    });
    return cycle;
  }

  private finishReviewCycle(
    run: LoopRun,
    status: "revision_requested" | "approved" | "superseded",
    evidence?: ReviewEvidence,
    reason?: string,
  ): void {
    const cycle = run.review_cycle;
    if (!cycle || cycle.status !== "active") return;
    if (!cycle.finding && run.pending_review_finding?.review_cycle === cycle.cycle) {
      cycle.finding = run.pending_review_finding;
    }
    cycle.status = status;
    cycle.completed_at = now();
    if (evidence) cycle.evidence = evidence;
    if (reason) cycle.completion_reason = reason;
    this.syncReviewCycle(run);
  }

  private syncReviewCycle(run: LoopRun): void {
    const cycle = run.review_cycle;
    if (!cycle) return;
    const index = run.review_cycles.findIndex((item) => item.cycle === cycle.cycle);
    if (index >= 0) run.review_cycles[index] = cycle;
    else run.review_cycles.push(cycle);
  }

  private async reconcileMondayReview(run: LoopRun, forced = false, allowRecovery = true): Promise<LoopRun> {
    if (!run.pr) return await this.block(run, "Monday review phase has no tracked PR.");
    const terminalEpisode = Boolean(run.monday.episode_started && run.monday.episode && EPISODE_TERMINAL.has(run.monday.episode.state));
    if (!await this.beginGithubPoll(run, forced || terminalEpisode || Boolean(run.monday.github_auth_error))) return run;
    const current = await this.github.findPullRequest(run.repo, run.branch, run.base_branch);
    if (!current) return await this.block(run, "Tracked PR is no longer open during Monday review.");
    const identityError = this.pullIdentityError(run, current);
    if (identityError) return await this.block(run, identityError);
    if (current.head_sha !== run.pr.head_sha) {
      this.finishReviewCycle(run, "superseded", undefined, `PR Head changed from ${run.pr.head_sha} to ${current.head_sha}.`);
      run.pr = { ...current, first_seen_at: run.pr.first_seen_at };
      run.ci = undefined;
      await this.progress(run, "head_changed", `PR Head changed to ${current.head_sha}; old approval and CI are invalid.`, { sha: current.head_sha });
      return await this.transition(run, "waiting_ci", "github", `CI for unexpected new SHA ${current.head_sha}`, "Head changed during review; previous approval is invalid.");
    }
    const cycle = run.review_cycle;
    if (!cycle || cycle.status !== "active" || cycle.pr_number !== run.pr.number || cycle.head_sha !== run.pr.head_sha) {
      return await this.block(run, "Active Monday review cycle is missing or does not match the tracked PR Head.");
    }
    const evidence = await this.github.getReviewEvidence(run.repo, run.pr.number);
    const monday = run.monday_github_login.toLowerCase();
    const authored = evidence.filter((item) => item.author.toLowerCase() === monday);
    const approval = authored.filter((item) => item.kind === "review" && item.state?.toUpperCase() === "APPROVED" && item.commit_id === run.pr!.head_sha)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (approval && (run.ci?.state === "success" || run.ci?.state === "none")) {
      await this.recordReviewProgress(run, approval);
      this.finishReviewCycle(run, "approved", approval, `Approved on Head ${run.pr.head_sha}.`);
      run.terminal_reason = `Approved by ${approval.author} on current Head ${run.pr.head_sha}`;
      return await this.transition(run, "completed", "none", "nothing; approval is terminal", "Current SHA received a valid Monday APPROVED review. PR remains open and unmerged.");
    }
    const baseline = new Set(cycle.baseline_evidence_ids);
    const newComment = authored.find((item) => !baseline.has(item.id) && this.isChangeEvidence(item, run));
    if (newComment) await this.recordReviewProgress(run, newComment);
    let newFinding = cycle.finding;
    if (!newFinding) {
      newFinding = await this.findAndStoreFinding(run, run.monday, run.latest_finding?.source_message_id ?? 0, {
        purpose: "review",
        reviewCycle: cycle.cycle,
        headSha: cycle.head_sha,
      });
      if (newFinding) {
        cycle.finding = newFinding;
        run.pending_review_finding = newFinding;
        this.syncReviewCycle(run);
        await this.store.writeRun(run);
      }
    }
    if (newComment && newFinding) {
      run.latest_finding = newFinding;
      run.pending_review_finding = undefined;
      this.finishReviewCycle(run, "revision_requested", newComment, `Revision requested for Head ${cycle.head_sha}.`);
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
    if (allowRecovery) return await this.recoverIfTerminal(run, run.monday, "Monday", missing);
    run.waiting_for = missing;
    await this.store.writeRun(run);
    return run;
  }

  private async recordReviewProgress(run: LoopRun, item: ReviewEvidence): Promise<void> {
    if (run.review_progress_evidence_ids.includes(item.id)) return;
    run.review_progress_evidence_ids.push(item.id);
    await this.progress(run, "review_observed", `Observed ${item.kind} ${item.id} from ${item.author}.`, { evidence_id: item.id, kind: item.kind });
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
    const previousEpisode = agent.episode;
    const cursor = Math.max(agent.dispatch_seq ?? 0, agent.last_agent_seq ?? 0);
    const [episode, messages] = await Promise.all([
      this.catsco.getEpisode(agent.topic_id),
      this.catsco.getMessagesAfter(agent.topic_id, cursor),
    ]);
    const observedAt = now();
    const episodeChanged = (previousEpisode?.run_id ?? "") !== (episode?.run_id ?? "")
      || (previousEpisode?.state ?? "") !== (episode?.state ?? "")
      || (previousEpisode?.updated_at ?? "") !== (episode?.updated_at ?? "");
    agent.episode = episode;
    agent.episode_observed_at = observedAt;
    if (episodeChanged) agent.last_episode_change_at = observedAt;
    const responses = messages.filter((message) => message.from_uid === agent.agent_uid);
    const response = responses.at(-1);
    if (response) {
      agent.last_agent_seq = Number(response.seq_id ?? response.id);
      agent.last_message_at = observedAt;
    }
    const directResponse = responses.filter((message) => !message.content_blocks?.some((block) => block.type === "tool_use" || block.type === "tool_result")).at(-1);
    if (directResponse) {
      const text = typeof directResponse.content === "string" ? directResponse.content : "";
      const strictWorkerRefusal = /(?:missing|缺少|未收到)[\s\S]{0,600}(?:LOOP_WORKTREE_CONTRACT_V1|execute_attempt|workspaceLease|targetTopicId)/i.test(text)
        && /(?:cannot|can't|refus|不能|无法)[\s\S]{0,600}(?:execute|proceed|create|push|执行|创建|推送|进入)/i.test(text);
      if (agent === run.developer) {
        agent.protocol_error = strictWorkerRefusal
          ? "Selected Developer is a strict execute_attempt worker and cannot accept direct-prompt Loop tasks. Choose a direct-capable Developer Agent or integrate the separate native A2A Harness."
          : undefined;
      }
      if (agent === run.monday) {
        const marker = `LOOP_BLOCKED_GITHUB_AUTH reviewer=${run.monday_github_login}`;
        const exactMarker = text.split(/\r?\n/).some((line) => line.trim() === marker);
        const explicitUnavailable = text.includes(run.monday_github_login)
          && /(?:credential|凭据|身份)[\s\S]{0,120}(?:unavailable|missing|未提供|不可用|无法)/i.test(text);
        if (exactMarker || explicitUnavailable) {
          agent.github_auth_error = `Required Monday GitHub reviewer identity ${run.monday_github_login} is unavailable; Run and PR were preserved for operator recovery.`;
        }
      }
    }
    agent.episode_started = Boolean(
      agent.episode_started || response || (episode?.run_id && episode.run_id !== agent.previous_episode_run_id),
    );
    const activity = [response ? "agent_message" : undefined, episodeChanged ? "episode_changed" : undefined]
      .filter((value): value is string => Boolean(value));
    if (activity.length) run.last_activity_at = observedAt;
    run.activity_state = computeActivityState(run, Date.parse(observedAt), this.config.activityStallMs);
    run.updated_at = observedAt;
    await this.store.writeRun(run);
    if (activity.length) {
      await this.store.appendEvent(run, { type: "agent_activity", message: "Observed new controlled-Agent activity.", data: { activity } });
    }
  }

  private async findAndStoreFinding(
    run: LoopRun,
    agent: AgentTurnState,
    afterMessageId: number,
    binding: { purpose: "initial" | "review"; reviewCycle?: number; headSha?: string },
  ): Promise<LoopRun["latest_finding"] | undefined> {
    if (!agent.topic_id) return undefined;
    const files = await this.catsco.getAgentFiles(agent.agent_uid, agent.topic_id);
    const candidates = files.filter((file) => file.message_id > Math.max(agent.dispatch_seq ?? 0, afterMessageId) && isZip(file)).sort((a, b) => b.message_id - a.message_id);
    for (const file of candidates) {
      const version = Math.max(0, ...run.finding_history.map((item) => item.version), run.latest_finding?.version ?? 0, run.pending_review_finding?.version ?? 0) + 1;
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
          purpose: binding.purpose,
          ...(binding.reviewCycle ? { review_cycle: binding.reviewCycle } : {}),
          ...(binding.headSha ? { head_sha: binding.headSha } : {}),
        };
        if (!run.finding_history.some((item) => item.id === finding.id)) run.finding_history.push(finding);
        await this.progress(run, "finding_validated", `Validated Finding ZIP v${version}.`, {
          file_id: file.id,
          sha256: downloaded.sha256,
          size: downloaded.size,
          purpose: binding.purpose,
          ...(binding.reviewCycle ? { review_cycle: binding.reviewCycle } : {}),
          ...(binding.headSha ? { head_sha: binding.headSha } : {}),
        });
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
    input.targetAgentUid = agent.agent_uid;
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
    agent.turn_started_at = sentAt;
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
    if (run.recovery_attempt >= RECOVERY_DELAYS.length) return await this.block(run, `Recovery attempts exhausted; still missing ${missing}.`);
    run.resume_phase = run.phase as Exclude<RunPhase, "recovering" | "paused">;
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
    run.next_retry_at = undefined;
    const reconciled = phase === "monday_finding"
      ? await this.reconcileMondayFinding(run, false)
      : phase === "developer_implementing"
        ? await this.reconcileDeveloper(run, true, false)
        : phase === "monday_review"
          ? await this.reconcileMondayReview(run, true, false)
          : run;
    if (reconciled.phase !== phase) return reconciled;
    run = reconciled;
    run.recovery_attempt += 1;
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

  private async wakeExplicitlyReconciledStall(run: LoopRun): Promise<LoopRun> {
    const agent = activityAgent(run);
    if (run.activity_state !== "suspected_stall" || !agent?.topic_id || agent.episode?.state !== "running") return run;
    const role = agent === run.developer ? "Developer" : "Monday";
    const fingerprint = createHash("sha256")
      .update(`${run.phase}:${agent.episode.run_id}:${run.last_activity_at}`)
      .digest("hex")
      .slice(0, 12);
    const action = `manual-reconcile-stall-${role.toLowerCase()}-${fingerprint}`;
    if (run.receipts[`${run.run_id}:${action}`]) return run;
    if (role === "Monday") run.monday_attempt += 1;
    else run.developer_attempt += 1;
    await this.dispatch(run, agent, action, {
      topicId: agent.topic_id,
      clientMsgId: "",
      text: supplementPrompt(run, role, run.waiting_for || "the current mechanical delivery"),
    });
    await this.store.appendEvent(run, {
      type: "stalled_episode_woken",
      message: `Operator reconcile explicitly woke the stalled ${role} Episode in its original Topic.`,
      data: { role, topic_id: agent.topic_id, episode_run_id: agent.episode?.run_id },
    });
    return run;
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

  private inferResumePhase(run: LoopRun): Exclude<RunPhase, "recovering" | "paused"> {
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

  private absoluteTimeoutReached(run: LoopRun): boolean {
    const created = Date.parse(run.created_at);
    return Number.isFinite(created) && Date.now() - created >= this.config.runAbsoluteTimeoutMs;
  }

  private mechanicalTimeoutReached(run: LoopRun): boolean {
    const progress = Date.parse(run.last_progress_at);
    return Number.isFinite(progress) && Date.now() - progress >= this.config.stageTimeoutMs;
  }

  private mechanicalTimeoutCanBlock(run: LoopRun): boolean {
    if (run.phase === "recovering") return false;
    const agent = activityAgent(run);
    if (run.recovery_attempt > 0 && agent && !agent.episode_started) return false;
    if (agent?.episode?.state === "running") return false;
    if (agent?.episode_started && agent.episode && EPISODE_TERMINAL.has(agent.episode.state)) return false;
    return true;
  }

  private async updateActivityState(run: LoopRun): Promise<void> {
    const state = computeActivityState(run, Date.now(), this.config.activityStallMs);
    if (state === run.activity_state) return;
    run.activity_state = state;
    run.updated_at = now();
    await this.store.writeRun(run);
    await this.store.appendEvent(run, { type: "activity_state_changed", message: `Activity state changed to ${state}.`, data: { state } });
  }

  private async block(run: LoopRun, reason: string): Promise<LoopRun> {
    this.rememberResumePhase(run);
    run.terminal_reason = reason;
    return await this.transition(run, "blocked", "none", "operator intervention", reason);
  }

  private rememberResumePhase(run: LoopRun): void {
    if (run.phase !== "recovering" && run.phase !== "paused") run.resume_phase = run.phase as Exclude<RunPhase, "recovering" | "paused">;
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
    const changedAt = now();
    if (previous !== phase) {
      const previousAgent = previous === "monday_finding" || previous === "monday_review"
        ? run.monday
        : previous === "developer_implementing"
          ? run.developer
          : undefined;
      if (previousAgent?.turn_started_at) {
        previousAgent.last_turn_started_at = previousAgent.turn_started_at;
        previousAgent.last_turn_ended_at = changedAt;
        previousAgent.last_turn_duration_ms = Math.max(0, Date.parse(changedAt) - Date.parse(previousAgent.turn_started_at));
        previousAgent.turn_started_at = undefined;
      }
      run.phase_started_at = changedAt;
    }
    run.phase = phase;
    run.active_actor = actor;
    run.waiting_for = waitingFor;
    if (phase === "completed") run.last_error = undefined;
    run.updated_at = changedAt;
    run.activity_state = computeActivityState(run, Date.parse(run.updated_at), this.config.activityStallMs);
    await this.store.writeRun(run);
    await this.store.appendEvent(run, { type: "phase_changed", message, data: { from: previous, to: phase, waiting_for: waitingFor } });
    return run;
  }
}
