import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import yazl from "yazl";
import { LoopController } from "../src/controller.js";
import { CatscoAuthError } from "../src/errors.js";
import { RunStore } from "../src/store.js";
import type { ControllerConfig, LoopRun } from "../src/types.js";
import { FakeCatsco, FakeGithub } from "./helpers.js";

async function findingZip(path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("# Finding\n"), "FINDING.md");
  zip.addBuffer(Buffer.from('{"version":1}\n'), "manifest.json");
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path);
    zip.outputStream.pipe(output).on("close", resolve).on("error", reject);
  });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "catsloop-test-"));
  const zip = join(root, "fixture.zip");
  await findingZip(zip);
  const config: ControllerConfig = {
    catscoBaseUrl: "https://cats.example", controllerUid: 363, mondayAgentUid: 553, developerAgentUid: 559,
    mondayGithubLogin: "monday-reviewer", developerGithubLogin: "developer", stateDir: join(root, "runs"),
    host: "127.0.0.1", port: 0, operatorToken: "secret", maxActiveRuns: 1, catscoPollMs: 5,
    githubPollMs: 5, idlePollMs: 5, noChecksGraceMs: 0, stageTimeoutMs: 90 * 60_000,
    activityStallMs: 20 * 60_000, runAbsoluteTimeoutMs: 4 * 60 * 60_000, maxFindingBytes: 10_000_000,
  };
  const store = new RunStore(config.stateDir);
  const catsco = new FakeCatsco();
  catsco.fixtureZip = zip;
  const github = new FakeGithub();
  const controller = new LoopController(config, store, catsco, github);
  await controller.initialize();
  return { root, config, store, catsco, github, controller };
}

async function advanceToDeveloper(ctx: Awaited<ReturnType<typeof setup>>): Promise<LoopRun> {
  let run = await ctx.controller.createRun({ request: "Implement the requested feature", repo: "acme/widget" });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "monday_finding");
  ctx.catsco.addFinding(run.monday.topic_id!);
  ctx.catsco.finish(run.monday.topic_id!);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "developer_implementing");
  return run;
}

async function advanceToReview(ctx: Awaited<ReturnType<typeof setup>>): Promise<LoopRun> {
  let run = await advanceToDeveloper(ctx);
  ctx.github.pr = { number: 42, url: "https://github.com/acme/widget/pull/42", state: "OPEN", base_ref: "main", head_ref: run.branch, head_sha: "abc123", author_login: "developer", head_repository: "acme/widget", head_repository_owner: "acme", first_seen_at: new Date().toISOString() };
  ctx.catsco.agentReply(run.developer.topic_id!, "PR ready");
  ctx.catsco.finish(run.developer.topic_id!);
  await ctx.controller.tick();
  ctx.github.ci = { sha: "abc123", state: "success", checks: [{ name: "test", state: "completed", conclusion: "success" }], observed_at: new Date().toISOString() };
  await ctx.controller.tick();
  return await ctx.store.readRun(run.run_id);
}

test("normal ZIP to PR to CI to current-SHA approval completes without merge", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const mondayTopic = run.monday.topic_id;
  const developerTopic = run.developer.topic_id;
  ctx.github.pr = { number: 42, url: "https://github.com/acme/widget/pull/42", state: "OPEN", base_ref: "main", head_ref: run.branch, head_sha: "abc123", author_login: "developer", head_repository: "acme/widget", head_repository_owner: "acme", first_seen_at: new Date().toISOString() };
  ctx.catsco.agentReply(developerTopic!, "PR ready");
  ctx.catsco.finish(developerTopic!);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "waiting_ci");
  ctx.github.ci = { sha: "abc123", state: "success", checks: [{ name: "test", state: "completed", conclusion: "success" }], observed_at: new Date().toISOString() };
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "monday_review");
  assert.equal(run.schema_version, 2);
  assert.equal(run.review_cycle?.cycle, 1);
  assert.equal(run.review_cycle?.head_sha, "abc123");
  assert.equal(run.review_cycle?.status, "active");
  assert.equal(run.monday.topic_id, mondayTopic, "Monday Topic must be reused");
  run.last_progress_at = new Date(Date.now() - 1_000).toISOString();
  await ctx.store.writeRun(run);
  const progressBeforeApproval = run.last_progress_at;
  ctx.github.evidence.push({ id: "review:1", kind: "review", author: "monday-reviewer", state: "APPROVED", commit_id: "abc123", created_at: new Date().toISOString() });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "completed");
  assert.equal(run.developer.topic_id, developerTopic, "Developer Topic must be reused");
  assert.match(run.terminal_reason!, /Approved/);
  assert.equal(run.review_cycle?.status, "approved");
  assert.equal(run.review_cycle?.evidence?.id, "review:1");
  assert.ok(Date.parse(run.last_progress_at) > Date.parse(progressBeforeApproval));
});

test("old approval is invalid after a new Head SHA", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  ctx.github.pr = { number: 7, url: "https://github.com/acme/widget/pull/7", state: "OPEN", base_ref: "main", head_ref: run.branch, head_sha: "sha1", author_login: "developer", head_repository: "acme/widget", head_repository_owner: "acme", first_seen_at: new Date().toISOString() };
  ctx.catsco.agentReply(run.developer.topic_id!, "done"); ctx.catsco.finish(run.developer.topic_id!);
  await ctx.controller.tick();
  ctx.github.ci = { sha: "sha1", state: "success", checks: [], observed_at: new Date().toISOString() };
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  ctx.github.evidence = [{ id: "review:old", kind: "review", author: "monday-reviewer", state: "APPROVED", commit_id: "sha1", created_at: new Date().toISOString() }];
  ctx.github.pr.head_sha = "sha2";
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "waiting_ci");
  assert.equal(run.pr?.head_sha, "sha2");
});

test("PR from an unexpected GitHub author is rejected mechanically", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  ctx.github.pr = {
    number: 9,
    url: "https://github.com/acme/widget/pull/9",
    state: "OPEN",
    base_ref: "main",
    head_ref: run.branch,
    head_sha: "foreign",
    author_login: "someone-else",
    head_repository: "acme/widget",
    head_repository_owner: "acme",
    first_seen_at: new Date().toISOString(),
  };
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked");
  assert.match(run.terminal_reason!, /does not match configured Developer identity/);
});

test("manual message pauses controlled run and resume preserves Topic", async () => {
  const ctx = await setup();
  let run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  const topic = ctx.catsco.topics.get(run.monday.topic_id!)!;
  const id = ctx.catsco.nextMessage++;
  topic.messages.push({ id, seq_id: id, topic_id: run.monday.topic_id!, from_uid: 999, content: "manual intervention" });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked");
  assert.equal(run.paused_for_manual_message?.message_id, id);
  const createdAt = run.created_at;
  const staleProgress = new Date(Date.now() - ctx.config.stageTimeoutMs - 1).toISOString();
  const staleActivity = new Date(Date.now() - ctx.config.activityStallMs - 1).toISOString();
  run.last_progress_at = staleProgress;
  run.last_activity_at = staleActivity;
  await ctx.store.writeRun(run);
  run = await ctx.controller.resume(run.run_id);
  assert.equal(run.phase, "monday_finding");
  assert.equal(run.monday.topic_id, topic.messages[0]?.topic_id);
  assert.ok(Date.parse(run.last_progress_at) > Date.parse(staleProgress));
  assert.ok(Date.parse(run.last_activity_at) > Date.parse(staleActivity));
  assert.equal(run.last_activity_at, run.last_progress_at);
  assert.equal(run.created_at, createdAt);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.notEqual(run.phase, "blocked");
});

test("GitHub polling is throttled within a phase while CatsCompany can still refresh", async () => {
  const ctx = await setup();
  ctx.config.githubPollMs = 60_000;
  const run = await advanceToDeveloper(ctx);
  await ctx.controller.tick();
  const firstPolls = ctx.github.findCalls;
  await ctx.controller.tick();
  assert.equal(ctx.github.findCalls, firstPolls);
  const persisted = await ctx.store.readRun(run.run_id);
  assert.ok(persisted.developer.episode_observed_at);
});

test("startup CatsCompany auth failure keeps state readable and marks active Runs blocked_auth", async () => {
  const ctx = await setup();
  let run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  await ctx.controller.tick();
  ctx.catsco.validateError = new CatscoAuthError("expired and login unavailable");
  const restarted = new LoopController(ctx.config, ctx.store, ctx.catsco, ctx.github);
  await restarted.initialize();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked_auth");
  assert.match(run.last_error!, /login unavailable/);
});

test("run.json is valid after atomic updates and events are append-only", async () => {
  const ctx = await setup();
  const run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  await ctx.controller.tick();
  const persisted = JSON.parse(await readFile(join(ctx.config.stateDir, run.run_id, "run.json"), "utf8")) as LoopRun;
  const events = (await readFile(join(ctx.config.stateDir, run.run_id, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(persisted.run_id, run.run_id);
  assert.ok(events.length >= 3);
  assert.deepEqual(events.map((line) => JSON.parse(line).seq), events.map((_, index) => index + 1));
});

test("ordinary CatsCompany files do not create a run", async () => {
  const ctx = await setup();
  ctx.catsco.topics.set("grp_ordinary", { agentUid: 553, messages: [], files: [] });
  ctx.catsco.addFinding("grp_ordinary");
  await ctx.controller.tick();
  assert.equal((await ctx.store.listRuns()).length, 0);
});

test("Developer terminal Episode without PR schedules recovery on the same Topic", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topic = run.developer.topic_id!;
  run.last_progress_at = new Date(Date.now() - ctx.config.stageTimeoutMs - 1).toISOString();
  await ctx.store.writeRun(run);
  ctx.catsco.agentReply(topic, "done without PR");
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "recovering");
  assert.equal(run.resume_phase, "developer_implementing");
  const messageCount = ctx.catsco.topics.get(topic)!.messages.length;
  assert.ok(Date.parse(run.next_retry_at!) > Date.now());
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "developer_implementing");
  assert.equal(run.developer.topic_id, topic);
  assert.equal(ctx.catsco.topics.get(topic)!.messages.length, messageCount + 1);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "developer_implementing");
});

test("recovery backoff still observes Agent activity without resending", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topic = run.developer.topic_id!;
  ctx.catsco.agentReply(topic, "done without PR");
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "recovering");
  const retryAt = run.next_retry_at;
  const controllerMessages = ctx.catsco.topics.get(topic)!.messages.filter((message) => message.from_uid === 363).length;
  run.last_activity_at = "2000-01-01T00:00:00.000Z";
  await ctx.store.writeRun(run);

  ctx.catsco.agentReply(topic, "late background progress");
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);

  assert.equal(run.phase, "recovering");
  assert.equal(run.next_retry_at, retryAt);
  assert.notEqual(run.last_activity_at, "2000-01-01T00:00:00.000Z");
  assert.equal(ctx.catsco.topics.get(topic)!.messages.filter((message) => message.from_uid === 363).length, controllerMessages);
});

test("recovery reconciles an externally created PR before sending another prompt", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topic = run.developer.topic_id!;
  ctx.catsco.agentReply(topic, "done without PR");
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "recovering");
  const controllerMessages = ctx.catsco.topics.get(topic)!.messages.filter((message) => message.from_uid === 363).length;
  ctx.github.pr = {
    number: 42,
    url: "https://github.com/acme/widget/pull/42",
    state: "OPEN",
    base_ref: "main",
    head_ref: run.branch,
    head_sha: "abc123",
    author_login: "developer",
    head_repository: "acme/widget",
    head_repository_owner: "acme",
    first_seen_at: new Date().toISOString(),
  };

  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);

  assert.equal(run.phase, "waiting_ci");
  assert.equal(run.pr?.head_sha, "abc123");
  assert.equal(run.recovery_attempt, 0);
  assert.equal(ctx.catsco.topics.get(topic)!.messages.filter((message) => message.from_uid === 363).length, controllerMessages);
});

test("Monday review with ZIP only preserves partial delivery and asks only for GitHub evidence", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  assert.equal(run.phase, "monday_review");
  ctx.catsco.addFinding(run.monday.topic_id!, "finding-v2.zip");
  ctx.catsco.finish(run.monday.topic_id!);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "recovering");
  assert.equal(run.pending_review_finding?.version, 2);
  assert.equal(run.pending_review_finding?.review_cycle, 1);
  assert.equal(run.pending_review_finding?.head_sha, "abc123");
  assert.equal(run.review_cycle?.finding?.id, run.pending_review_finding?.id);
  assert.match(run.waiting_for, /GitHub review\/comment/);
});

test("a Finding from an old Head is archived and cannot pair with a later review cycle", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  const mondayTopic = run.monday.topic_id!;

  ctx.catsco.addFinding(mondayTopic, "finding-head-a.zip");
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  const oldFinding = run.review_cycle?.finding;
  assert.equal(oldFinding?.head_sha, "abc123");
  assert.equal(run.review_cycle?.status, "active");

  ctx.github.pr!.head_sha = "def456";
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "waiting_ci");
  assert.equal(run.review_cycles[0]?.status, "superseded");
  assert.equal(run.review_cycles[0]?.finding?.id, oldFinding?.id);

  ctx.github.ci = { sha: "def456", state: "success", checks: [{ name: "test", state: "completed", conclusion: "success" }], observed_at: new Date().toISOString() };
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "monday_review");
  assert.equal(run.review_cycle?.cycle, 2);
  assert.equal(run.review_cycle?.head_sha, "def456");
  assert.equal(run.review_cycle?.finding, undefined);
  assert.equal(run.pending_review_finding, undefined);

  ctx.github.evidence.push({ id: "issue:new-head", kind: "issue_comment", author: "monday-reviewer", created_at: new Date().toISOString() });
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "monday_review", "new comment must not pair with the archived old-Head ZIP");
  assert.equal(run.review_cycle?.finding, undefined);
  assert.match(run.waiting_for, /Finding ZIP/);

  ctx.catsco.addFinding(mondayTopic, "finding-head-b.zip");
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "developer_implementing");
  assert.equal(run.review_cycles[1]?.status, "revision_requested");
  assert.equal(run.review_cycles[1]?.head_sha, "def456");
  assert.equal(run.review_cycles[1]?.finding?.head_sha, "def456");
  assert.equal(run.review_cycles[1]?.evidence?.id, "issue:new-head");
  assert.equal(run.finding_history.length, 3);
});

test("crash reconciliation reuses an existing uniquely named Agent Task", async () => {
  const ctx = await setup();
  const run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  const name = `Loop ${run.run_id} · Monday`;
  const task = await ctx.catsco.createAgentTask(name, 553);
  await ctx.controller.tick();
  const persisted = await ctx.store.readRun(run.run_id);
  assert.equal(persisted.monday.topic_id, task.topic);
  assert.equal(ctx.catsco.topics.size, 1);
});

test("strict execute_attempt worker refusal blocks immediately instead of retrying", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topic = run.developer.topic_id!;
  ctx.catsco.agentReply(topic, "Missing LOOP_WORKTREE_CONTRACT_V1, workspaceLease and targetTopicId for execute_attempt; cannot create or push the PR.");
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked");
  assert.match(run.terminal_reason!, /strict execute_attempt worker/);
  assert.equal(run.recovery_attempt, 0);
});

test("protocol names inside ordinary tool output do not misclassify a direct Developer", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topic = run.developer.topic_id!;
  ctx.catsco.agentReply(topic, "Command completed: README says a strict execute_attempt worker requires LOOP_WORKTREE_CONTRACT_V1 and workspaceLease.");
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "recovering");
  assert.equal(run.developer.protocol_error, undefined);
});

test("strict worker refusal text inside a structured tool result is not treated as a Developer refusal", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topic = run.developer.topic_id!;
  const text = "Missing LOOP_WORKTREE_CONTRACT_V1 and workspaceLease; cannot create or push the PR.";
  ctx.catsco.agentReply(topic, text, [{ type: "tool_result", tool_use_id: "call_read", content: text }]);
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "recovering");
  assert.equal(run.developer.protocol_error, undefined);
});

test("GitHub auth marker inside Monday tool transcript is not a blocking delivery", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  ctx.catsco.agentReply(
    run.monday.topic_id!,
    "Command completed\nstatus: succeeded\ncommand: if missing: print('LOOP_BLOCKED_GITHUB_AUTH reviewer=monday-reviewer')\nstdout:\nAPPROVED",
  );
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.notEqual(run.phase, "blocked_github_auth");
  assert.equal(run.monday.github_auth_error, undefined);
});

test("missing required Monday reviewer identity blocks GitHub auth without futile recovery", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  ctx.catsco.addFinding(run.monday.topic_id!, "finding-before-auth-restore.zip");
  ctx.catsco.agentReply(run.monday.topic_id!, "LOOP_BLOCKED_GITHUB_AUTH reviewer=monday-reviewer");
  ctx.catsco.finish(run.monday.topic_id!);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked_github_auth");
  assert.equal(run.recovery_attempt, 0);
  assert.match(run.last_error!, /monday-reviewer/);
  const topic = run.monday.topic_id!;
  const priorDispatch = run.monday.dispatch_seq;
  const archivedFindingId = run.pending_review_finding?.id;
  assert.ok(archivedFindingId);
  run = await ctx.controller.resume(run.run_id);
  assert.equal(run.phase, "monday_review");
  assert.equal(run.monday.topic_id, topic);
  assert.ok(run.monday.dispatch_seq! > priorDispatch!);
  assert.equal(run.monday.github_auth_error, undefined);
  assert.equal(run.pending_review_finding, undefined);
  assert.equal(run.review_cycles[0]?.status, "superseded");
  assert.equal(run.review_cycles[0]?.finding?.id, archivedFindingId);
  assert.equal(run.review_cycle?.cycle, 2);
  assert.equal(run.review_cycle?.status, "active");
  assert.ok(run.finding_history.some((item) => item.id === archivedFindingId));
  assert.match(String(ctx.catsco.topics.get(topic)!.messages.at(-1)?.content), /monday-reviewer/);
  ctx.github.evidence.push({ id: "review:restored", kind: "review", author: "monday-reviewer", state: "APPROVED", commit_id: "abc123", created_at: new Date().toISOString() });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "completed");
});

test("recovery message keys remain unique after partial mechanical progress resets backoff", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  const topic = run.monday.topic_id!;
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  const firstKey = run.monday.last_prompt_key;
  ctx.catsco.addFinding(topic, "finding-v2.zip");
  ctx.catsco.finish(topic);
  await ctx.controller.tick();
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  assert.notEqual(run.monday.last_prompt_key, firstKey);
  const controllerMessages = ctx.catsco.topics.get(topic)!.messages.filter((message) => message.from_uid === 363);
  assert.equal(new Set(controllerMessages.map((message) => message.client_msg_id)).size, controllerMessages.length);
});

test("running Episode is not blocked by mechanical timeout and inactivity only reports suspected_stall", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topicId = run.developer.topic_id!;
  const episode = { topic_id: topicId, run_id: "episode_running", state: "running", updated_at: "2026-08-11T00:00:00.000Z" };
  ctx.catsco.topics.get(topicId)!.episode = episode;
  run.developer.episode = episode;
  run.developer.episode_started = true;
  run.last_progress_at = new Date(Date.now() - ctx.config.stageTimeoutMs - 1).toISOString();
  run.last_activity_at = new Date(Date.now() - ctx.config.activityStallMs - 1).toISOString();
  const messageCount = ctx.catsco.topics.get(topicId)!.messages.length;
  await ctx.store.writeRun(run);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "developer_implementing");
  assert.equal(run.activity_state, "suspected_stall");
  assert.equal(run.recovery_attempt, 0);
  assert.equal(ctx.catsco.topics.get(topicId)!.messages.length, messageCount);
});

test("controlled-Agent message and Episode changes advance activity only once per fact", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topicId = run.developer.topic_id!;
  const old = "2000-01-01T00:00:00.000Z";
  const mechanicalProgress = run.last_progress_at;
  run.last_activity_at = old;
  await ctx.store.writeRun(run);
  ctx.catsco.agentReply(topicId, "working");
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  const messageActivity = run.last_activity_at;
  assert.notEqual(messageActivity, old);
  assert.equal(run.developer.last_message_at, messageActivity);
  assert.equal(run.last_progress_at, mechanicalProgress);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.last_activity_at, messageActivity);

  run.last_activity_at = old;
  await ctx.store.writeRun(run);
  ctx.catsco.topics.get(topicId)!.episode = { topic_id: topicId, run_id: "episode_1", state: "running", updated_at: "2026-08-11T00:00:00.000Z" };
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.notEqual(run.last_activity_at, old);
  assert.equal(run.developer.last_episode_change_at, run.last_activity_at);
  assert.equal(run.activity_state, "active");

  run.last_activity_at = old;
  await ctx.store.writeRun(run);
  ctx.catsco.topics.get(topicId)!.episode = { topic_id: topicId, run_id: "episode_1", state: "waiting", updated_at: "2026-08-11T00:01:00.000Z" };
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.notEqual(run.last_activity_at, old);
  assert.equal(run.activity_state, "quiet");
});

test("operator soft pause sends no message and resume continues the same Topic", async () => {
  const ctx = await setup();
  let run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  const topicId = run.monday.topic_id!;
  const messageCount = ctx.catsco.topics.get(topicId)!.messages.length;
  run = await ctx.controller.pause(run.run_id);
  assert.equal(run.phase, "paused");
  assert.equal(run.resume_phase, "monday_finding");
  assert.equal(run.active_actor, "none");
  assert.equal(ctx.catsco.topics.get(topicId)!.messages.length, messageCount, "pause must not send an Agent message");
  await ctx.controller.tick();
  assert.equal((await ctx.store.readRun(run.run_id)).phase, "paused", "scheduler must leave paused Runs untouched");
  run = await ctx.controller.resume(run.run_id);
  assert.equal(run.phase, "monday_finding");
  assert.equal(run.monday.topic_id, topicId);
  assert.equal(ctx.catsco.topics.get(topicId)!.messages.length, messageCount, "resume reconciles before any later continuation");
});

test("a softly paused Run does not consume the active execution slot", async () => {
  const ctx = await setup();
  let first = await ctx.controller.createRun({ request: "first", repo: "acme/widget" });
  await ctx.controller.tick();
  first = await ctx.store.readRun(first.run_id);
  assert.equal(first.phase, "monday_finding");
  const second = await ctx.controller.createRun({ request: "second", repo: "acme/widget" });
  await ctx.controller.pause(first.run_id);
  await ctx.controller.tick();
  assert.equal((await ctx.store.readRun(first.run_id)).phase, "paused");
  assert.equal((await ctx.store.readRun(second.run_id)).phase, "monday_finding");
});

test("createRun is idempotent and resolves the repository default branch", async () => {
  const ctx = await setup();
  ctx.github.defaultBranch = "develop";
  const first = await ctx.controller.createRun({ request: "work", repo: "acme/widget", idempotency_key: "cats-message-12345" });
  const repeated = await ctx.controller.createRun({ request: "work", repo: "acme/widget", idempotency_key: "cats-message-12345" });
  assert.equal(first.run_id, repeated.run_id);
  assert.equal(first.base_branch, "develop");
  assert.equal((await ctx.store.listRuns()).length, 1);
  await assert.rejects(
    ctx.controller.createRun({ request: "different work", repo: "acme/widget", idempotency_key: "cats-message-12345" }),
    /different request/,
  );
});

test("role turns retain start, message activity, and completed duration across handoff", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  assert.ok(run.monday.last_turn_started_at);
  assert.ok(run.monday.last_turn_ended_at);
  assert.ok((run.monday.last_turn_duration_ms ?? -1) >= 0);
  assert.ok(run.developer.turn_started_at);
  assert.ok(run.phase_started_at);

  const developerStart = run.developer.turn_started_at;
  ctx.github.pr = { number: 42, url: "https://github.com/acme/widget/pull/42", state: "OPEN", base_ref: "main", head_ref: run.branch, head_sha: "abc123", author_login: "developer", head_repository: "acme/widget", head_repository_owner: "acme", first_seen_at: new Date().toISOString() };
  ctx.catsco.agentReply(run.developer.topic_id!, "PR ready");
  ctx.catsco.finish(run.developer.topic_id!);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "waiting_ci");
  assert.equal(run.developer.turn_started_at, undefined);
  assert.equal(run.developer.last_turn_started_at, developerStart);
  assert.ok(run.developer.last_message_at);
  assert.ok(run.developer.last_turn_ended_at);
  assert.ok((run.developer.last_turn_duration_ms ?? -1) >= 0);
});

test("absolute Run limit blocks a running Episode", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  const topicId = run.developer.topic_id!;
  const episode = { topic_id: topicId, run_id: "episode_running", state: "running", updated_at: new Date().toISOString() };
  ctx.catsco.topics.get(topicId)!.episode = episode;
  run.developer.episode = episode;
  run.developer.episode_started = true;
  run.created_at = new Date(Date.now() - ctx.config.runAbsoluteTimeoutMs - 1).toISOString();
  await ctx.store.writeRun(run);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked");
  assert.match(run.terminal_reason!, /absolute limit/);
});

test("absolute Run limit sweeps queued Runs outside the active slot", async () => {
  const ctx = await setup();
  const active = await ctx.controller.createRun({ request: "active", repo: "acme/widget" });
  await ctx.controller.tick();
  assert.equal((await ctx.store.readRun(active.run_id)).phase, "monday_finding");
  let queued = await ctx.controller.createRun({ request: "queued", repo: "acme/widget" });
  queued.created_at = new Date(Date.now() - ctx.config.runAbsoluteTimeoutMs - 1).toISOString();
  await ctx.store.writeRun(queued);
  await ctx.controller.tick();
  queued = await ctx.store.readRun(queued.run_id);
  assert.equal(queued.phase, "blocked");
  assert.match(queued.terminal_reason!, /absolute limit/);
});

test("legacy run.json reads are pure and explicit startup migration persists disclosure fields", async () => {
  const ctx = await setup();
  const run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  const path = join(ctx.config.stateDir, run.run_id, "run.json");
  const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  delete legacy.last_activity_at;
  delete legacy.activity_state;
  delete legacy.review_progress_evidence_ids;
  legacy.schema_version = 1;
  delete legacy.finding_history;
  delete legacy.review_cycles;
  delete legacy.review_cycle;
  const persistedBeforeRead = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(path, persistedBeforeRead);
  const normalized = await ctx.store.readRun(run.run_id);
  assert.equal(normalized.last_activity_at, normalized.last_progress_at);
  assert.equal(normalized.activity_state, "quiet");
  assert.deepEqual(normalized.review_progress_evidence_ids, []);
  assert.deepEqual(normalized.finding_history, []);
  assert.deepEqual(normalized.review_cycles, []);
  assert.equal(await readFile(path, "utf8"), persistedBeforeRead);

  assert.deepEqual(await ctx.store.migrateLegacyRuns(), [run.run_id]);
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.ok(persisted.last_activity_at);
  assert.ok(persisted.last_progress_at);
  assert.ok(persisted.activity_state);
  assert.ok(Array.isArray(persisted.review_progress_evidence_ids));
  assert.equal(persisted.schema_version, 2);
  assert.ok(Array.isArray(persisted.finding_history));
  assert.ok(Array.isArray(persisted.review_cycles));
  assert.deepEqual(await ctx.store.migrateLegacyRuns(), [], "migration must be idempotent");
});

test("legacy pending review Finding is migrated into its current Head cycle", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  ctx.catsco.addFinding(run.monday.topic_id!, "legacy-pending.zip");
  await ctx.controller.reconcile(run.run_id);
  run = await ctx.store.readRun(run.run_id);
  const path = join(ctx.config.stateDir, run.run_id, "run.json");
  const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  legacy.schema_version = 1;
  delete legacy.finding_history;
  delete legacy.review_cycles;
  delete legacy.review_cycle;
  delete legacy.pending_review_finding.purpose;
  delete legacy.pending_review_finding.review_cycle;
  delete legacy.pending_review_finding.head_sha;
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);

  assert.deepEqual(await ctx.store.migrateLegacyRuns(), [run.run_id]);
  const migrated = await ctx.store.readRun(run.run_id);
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.review_cycle?.status, "active");
  assert.equal(migrated.review_cycle?.head_sha, "abc123");
  assert.equal(migrated.review_cycle?.finding?.review_cycle, 1);
  assert.equal(migrated.review_cycle?.finding?.head_sha, "abc123");
  assert.equal(migrated.finding_history.at(-1)?.id, migrated.pending_review_finding?.id);
});

test("manual reconcile and scheduler serialize per Run", async () => {
  const ctx = await setup();
  const run = await ctx.controller.createRun({ request: "work", repo: "acme/widget" });
  await Promise.all([ctx.controller.reconcile(run.run_id), ctx.controller.tick(), ctx.controller.reconcile(run.run_id)]);
  const persisted = await ctx.store.readRun(run.run_id);
  assert.equal(persisted.phase, "monday_finding");
  assert.equal(ctx.catsco.topics.size, 1);
  assert.equal(ctx.catsco.topics.get(persisted.monday.topic_id!)!.messages.filter((message) => message.from_uid === 363).length, 1);
});
