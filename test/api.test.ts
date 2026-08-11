import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as yazl from "yazl";
import { createLoopApi } from "../src/app.js";
import type { LoopController } from "../src/controller.js";
import { RunStore } from "../src/store.js";
import type { LoopRun } from "../src/types.js";

function runFixture(): LoopRun {
  const created = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: "run_api_fields",
    phase: "queued",
    active_actor: "controller",
    waiting_for: "slot",
    iteration: 0,
    monday_attempt: 0,
    developer_attempt: 0,
    recovery_attempt: 0,
    request: "work",
    repo: "acme/widget",
    base_branch: "main",
    branch: "loop/run_api_fields",
    monday_github_login: "monday",
    developer_github_login: "developer",
    monday: { agent_uid: 553, episode_started: false },
    developer: { agent_uid: 559, episode_started: false },
    review_baseline_comment_ids: [],
    review_progress_evidence_ids: [],
    sent_message_ids: [],
    receipts: {},
    created_at: created,
    updated_at: created,
    activity_state: "quiet",
    last_activity_at: created,
    last_progress_at: created,
    cancel_requested: false,
  };
}

class PausingReadStore extends RunStore {
  private pauseNextRead = false;
  private reading = false;
  private signalEntered: () => void = () => {};
  private releaseGate: () => void = () => {};
  private gate: Promise<void> = Promise.resolve();
  entered: Promise<void> = Promise.resolve();
  writesDuringRead = 0;

  arm(): void {
    this.pauseNextRead = true;
    this.entered = new Promise<void>((resolve) => { this.signalEntered = resolve; });
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  release(): void {
    this.releaseGate();
  }

  private async pauseIfArmed(): Promise<void> {
    if (!this.pauseNextRead) return;
    this.pauseNextRead = false;
    this.signalEntered();
    await this.gate;
  }

  override async readRun(runId: string): Promise<LoopRun> {
    this.reading = true;
    try {
      const run = await super.readRun(runId);
      await this.pauseIfArmed();
      return run;
    } finally {
      this.reading = false;
    }
  }

  override async writeRun(run: LoopRun): Promise<void> {
    if (this.reading) {
      this.writesDuringRead += 1;
      // With the old implementation, readRun() called this method after
      // parsing its stale snapshot. Pause that stale write until the test has
      // persisted a newer Controller snapshot, then release it so the test
      // deterministically exercises the destructive interleaving.
      await this.pauseIfArmed();
    }
    await super.writeRun(run);
  }
}

async function writeFinding(path: string, markdown: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(markdown), "review/FINDING.md");
  zip.addBuffer(Buffer.from('{"version":1}\n'), "review/manifest.json");
  zip.end();
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(path)).once("close", resolve).once("error", reject);
  });
}

test("API requires operator token, enforces exact CORS origin, and discloses Run timing fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "catsloop-api-"));
  const store = new RunStore(root);
  await store.initialize(runFixture());
  const controller = {
    config: { operatorToken: "secret", allowedOrigin: "https://artifact.example:19991" },
  } as unknown as LoopController;
  const api = createLoopApi(controller, store);
  const address = await api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer secret", origin: "https://artifact.example:19991" };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    const allowed = await fetch(`${base}/api/runs`, { headers });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://artifact.example:19991");
    const listed = await allowed.json() as { runs: LoopRun[] };
    assert.equal(listed.runs[0]?.activity_state, "quiet");
    assert.ok(listed.runs[0]?.last_activity_at);
    assert.ok(listed.runs[0]?.last_progress_at);
    assert.ok(listed.runs[0]?.phase_started_at);
    const detail = await fetch(`${base}/api/runs/run_api_fields`, { headers });
    const body = await detail.json() as LoopRun;
    assert.equal(body.activity_state, "quiet");
    assert.ok(body.last_activity_at);
    assert.ok(body.last_progress_at);
    assert.ok(body.phase_started_at);
    const denied = await fetch(`${base}/api/runs`, { headers: { authorization: "Bearer secret", origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
  } finally {
    await api.close();
  }
});

test("API exposes validated Finding markdown and authenticated ZIP download", async () => {
  const root = await mkdtemp(join(tmpdir(), "catsloop-api-finding-"));
  const store = new RunStore(root);
  const run = runFixture();
  run.run_id = "run_api_finding";
  run.branch = "loop/run_api_finding";
  const path = await store.findingPath(run.run_id, 1);
  await writeFinding(path, "# 发现\n\n- 保留 Review Cycle 证据。\n");
  const finding = {
    version: 1,
    id: "finding-1",
    name: "finding.zip",
    url: "https://cats.example/uploads/finding.zip",
    source_message_id: 7,
    source_topic_id: "grp_monday",
    size: (await readFile(path)).length,
    sha256: "abc123",
    stored_path: path,
    validated_at: new Date().toISOString(),
  };
  run.latest_finding = finding;
  run.finding_history = [finding];
  await store.initialize(run);
  const controller = {
    config: { operatorToken: "secret", allowedOrigin: "https://artifact.example:19991" },
  } as unknown as LoopController;
  const api = createLoopApi(controller, store);
  const address = await api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer secret", origin: "https://artifact.example:19991" };
  try {
    const content = await fetch(`${base}/api/runs/${run.run_id}/findings/1`, { headers });
    assert.equal(content.status, 200);
    const body = await content.json() as { markdown: string };
    assert.match(body.markdown, /保留 Review Cycle 证据/);
    const download = await fetch(`${base}/api/runs/${run.run_id}/findings/1/download`, { headers });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.equal(download.headers.get("content-disposition"), 'attachment; filename="finding-v1.zip"');
    assert.ok((await download.arrayBuffer()).byteLength > 0);
  } finally {
    await api.close();
  }
});

test("stale API read cannot overwrite a fresh Controller write", async () => {
  const root = await mkdtemp(join(tmpdir(), "catsloop-api-race-"));
  const store = new PausingReadStore(root, 20 * 60_000);
  const stale = runFixture();
  stale.run_id = "run_api_race";
  stale.phase = "developer_implementing";
  stale.active_actor = "developer";
  stale.waiting_for = "an open PR";
  stale.branch = "loop/run_api_race";
  stale.developer = { ...stale.developer, topic_id: "grp_developer" };
  stale.last_activity_at = "2000-01-01T00:00:00.000Z";
  stale.activity_state = "quiet";
  await store.initialize(stale);
  const controller = {
    config: { operatorToken: "secret", allowedOrigin: "https://artifact.example:19991" },
  } as unknown as LoopController;
  const api = createLoopApi(controller, store);
  const address = await api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer secret", origin: "https://artifact.example:19991" };
  try {
    store.arm();
    const staleResponsePromise = fetch(`${base}/api/runs/${stale.run_id}`, { headers });
    await store.entered;
    const fresh = structuredClone(stale);
    fresh.updated_at = new Date(Date.now() + 1_000).toISOString();
    fresh.last_progress_at = fresh.updated_at;
    fresh.waiting_for = "CI for fresh-sha";
    fresh.pr = {
      number: 3,
      url: "https://github.com/acme/widget/pull/3",
      state: "OPEN",
      base_ref: "main",
      head_ref: fresh.branch,
      head_sha: "fresh-sha",
      author_login: "developer",
      head_repository: "acme/widget",
      head_repository_owner: "acme",
      first_seen_at: fresh.updated_at,
    };
    await RunStore.prototype.writeRun.call(store, fresh);
    store.release();
    const staleResponse = await staleResponsePromise;
    assert.equal(staleResponse.status, 200);
    const staleBody = await staleResponse.json() as LoopRun;
    assert.equal(staleBody.activity_state, "suspected_stall");
    assert.equal(staleBody.last_activity_at, stale.last_activity_at);
    assert.equal(staleBody.last_progress_at, stale.last_progress_at);
    assert.equal(store.writesDuringRead, 0, "GET/readRun must not write a normalized snapshot");
    const persisted = JSON.parse(await readFile(join(root, stale.run_id, "run.json"), "utf8")) as LoopRun;
    assert.equal(persisted.pr?.head_sha, "fresh-sha");
    assert.equal(persisted.waiting_for, "CI for fresh-sha");
    assert.equal(persisted.last_progress_at, fresh.last_progress_at);
  } finally {
    store.release();
    await api.close();
  }
});
