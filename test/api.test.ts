import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    const detail = await fetch(`${base}/api/runs/run_api_fields`, { headers });
    const body = await detail.json() as LoopRun;
    assert.equal(body.activity_state, "quiet");
    assert.ok(body.last_activity_at);
    assert.ok(body.last_progress_at);
    const denied = await fetch(`${base}/api/runs`, { headers: { authorization: "Bearer secret", origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
  } finally {
    await api.close();
  }
});
