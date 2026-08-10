import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLoopApi } from "../src/app.js";
import type { LoopController } from "../src/controller.js";
import { RunStore } from "../src/store.js";

test("API requires operator token and enforces exact CORS origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "catsloop-api-"));
  const store = new RunStore(root);
  const controller = {
    config: { operatorToken: "secret", allowedOrigin: "https://artifact.example:19991" },
  } as unknown as LoopController;
  const api = createLoopApi(controller, store);
  const address = await api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    const allowed = await fetch(`${base}/api/runs`, { headers: { authorization: "Bearer secret", origin: "https://artifact.example:19991" } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://artifact.example:19991");
    const denied = await fetch(`${base}/api/runs`, { headers: { authorization: "Bearer secret", origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
  } finally {
    await api.close();
  }
});
