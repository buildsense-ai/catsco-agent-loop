import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CatscoClient } from "../src/catsco-client.js";
import { CatscoAuthError } from "../src/errors.js";
import type { ControllerConfig } from "../src/types.js";

function config(base: string, state: string): ControllerConfig {
  return {
    catscoBaseUrl: base, catscoToken: "expired", catscoAccount: "controller", catscoPassword: "password",
    controllerUid: 363, mondayAgentUid: 553, developerAgentUid: 559, mondayGithubLogin: "monday",
    developerGithubLogin: "developer", stateDir: state, host: "127.0.0.1", port: 0, operatorToken: "secret",
    maxActiveRuns: 1, catscoPollMs: 5, githubPollMs: 5, idlePollMs: 5, noChecksGraceMs: 0,
    stageTimeoutMs: 45 * 60_000, maxFindingBytes: 1024,
  };
}

test("401 performs one persistent login, caches token, and retries original request", async () => {
  let loginCalls = 0;
  let meCalls = 0;
  let persistent = false;
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") {
      loginCalls += 1;
      persistent = JSON.parse(Buffer.concat(body).toString()).persistent === true;
      response.end(JSON.stringify({ token: "fresh" }));
      return;
    }
    if (request.url === "/api/me") {
      meCalls += 1;
      if (request.headers.authorization !== "Bearer fresh") { response.statusCode = 401; response.end('{"error":"expired"}'); return; }
      response.end('{"uid":363,"username":"controller"}');
      return;
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "catsloop-auth-"));
  const tokenPath = join(root, "token.json");
  try {
    const client = new CatscoClient(config(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, root), tokenPath);
    assert.equal((await client.validateSession()).uid, 363);
    assert.equal(loginCalls, 1);
    assert.equal(meCalls, 2);
    assert.equal(persistent, true);
    assert.equal(JSON.parse(await readFile(tokenPath, "utf8")).token, "fresh");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("403 is terminal auth failure and does not attempt login", async () => {
  let loginCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") loginCalls += 1;
    response.statusCode = 403; response.end('{"error":"account disabled"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "catsloop-auth-"));
  try {
    const client = new CatscoClient(config(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, root), join(root, "token.json"));
    await assert.rejects(client.validateSession(), CatscoAuthError);
    assert.equal(loginCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("stable client_msg_id remains unchanged across a duplicate send", async () => {
  const seen = new Map<string, number>();
  let next = 1;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url !== "/api/messages/send") { response.end('{"uid":363}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { client_msg_id: string; topic_id: string };
    const duplicate = seen.has(body.client_msg_id);
    const id = seen.get(body.client_msg_id) ?? next++;
    seen.set(body.client_msg_id, id);
    response.end(JSON.stringify({ id, seq_id: id, topic_id: body.topic_id, client_msg_id: body.client_msg_id, duplicate }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "catsloop-idem-"));
  try {
    const cfg = config(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, root);
    cfg.catscoToken = "valid";
    const client = new CatscoClient(cfg, join(root, "token.json"));
    const input = { topicId: "grp_1", clientMsgId: "run_x:phase:0:action", text: "hello" };
    const first = await client.sendMessage(input);
    const second = await client.sendMessage(input);
    assert.equal(first.id, second.id);
    assert.equal(second.duplicate, true);
    assert.equal(seen.size, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
