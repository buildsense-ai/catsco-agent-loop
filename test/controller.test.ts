import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import yazl from "yazl";
import { LoopController } from "../src/controller.js";
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
    githubPollMs: 5, idlePollMs: 5, noChecksGraceMs: 0, stageTimeoutMs: 45 * 60_000, maxFindingBytes: 10_000_000,
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
  assert.equal(run.monday.topic_id, mondayTopic, "Monday Topic must be reused");
  ctx.github.evidence.push({ id: "review:1", kind: "review", author: "monday-reviewer", state: "APPROVED", commit_id: "abc123", created_at: new Date().toISOString() });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "completed");
  assert.equal(run.developer.topic_id, developerTopic, "Developer Topic must be reused");
  assert.match(run.terminal_reason!, /Approved/);
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
  topic.messages.push({ id, topic_id: run.monday.topic_id!, from_uid: 363, content: "manual intervention" });
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked");
  assert.equal(run.paused_for_manual_message?.message_id, id);
  run = await ctx.controller.resume(run.run_id);
  assert.equal(run.phase, "monday_finding");
  assert.equal(run.monday.topic_id, topic.messages[0]?.topic_id);
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
  assert.match(run.waiting_for, /GitHub review\/comment/);
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

test("missing required Monday reviewer identity blocks GitHub auth without futile recovery", async () => {
  const ctx = await setup();
  let run = await advanceToReview(ctx);
  ctx.catsco.agentReply(run.monday.topic_id!, "LOOP_BLOCKED_GITHUB_AUTH reviewer=monday-reviewer");
  ctx.catsco.finish(run.monday.topic_id!);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked_github_auth");
  assert.equal(run.recovery_attempt, 0);
  assert.match(run.last_error!, /monday-reviewer/);
  const topic = run.monday.topic_id!;
  const priorDispatch = run.monday.dispatch_seq;
  run = await ctx.controller.resume(run.run_id);
  assert.equal(run.phase, "monday_review");
  assert.equal(run.monday.topic_id, topic);
  assert.ok(run.monday.dispatch_seq! > priorDispatch!);
  assert.equal(run.monday.github_auth_error, undefined);
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

test("global no-progress timeout blocks a still-running Episode", async () => {
  const ctx = await setup();
  let run = await advanceToDeveloper(ctx);
  run.last_progress_at = new Date(Date.now() - ctx.config.stageTimeoutMs - 1).toISOString();
  await ctx.store.writeRun(run);
  await ctx.controller.tick();
  run = await ctx.store.readRun(run.run_id);
  assert.equal(run.phase, "blocked");
  assert.match(run.terminal_reason!, /No mechanical progress/);
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
