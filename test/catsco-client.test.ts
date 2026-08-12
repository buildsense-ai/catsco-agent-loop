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
    stageTimeoutMs: 90 * 60_000, activityStallMs: 20 * 60_000, runAbsoluteTimeoutMs: 4 * 60 * 60_000, maxFindingBytes: 1024,
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

test("Finding download refreshes an expired token and retries the same URL", async () => {
  let loginCalls = 0;
  let downloadCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/api/auth/login") {
      loginCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end('{"token":"fresh"}');
      return;
    }
    if (request.url === "/uploads/files/finding.zip") {
      downloadCalls += 1;
      if (request.headers.authorization !== "Bearer fresh") {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end('{"error":"expired"}');
        return;
      }
      response.end("zip-bytes");
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "catsloop-download-auth-"));
  try {
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const client = new CatscoClient(config(base, root), join(root, "token.json"));
    const destination = join(root, "finding.zip");
    const downloaded = await client.download(`${base}/uploads/files/finding.zip`, destination, 1024);
    assert.equal(loginCalls, 1);
    assert.equal(downloadCalls, 2);
    assert.equal(downloaded.size, 9);
    assert.equal(await readFile(destination, "utf8"), "zip-bytes");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("stable client_msg_id remains unchanged across a duplicate send", async () => {
  const seen = new Map<string, number>();
  const requestBodies: Array<{ client_msg_id: string; topic_id: string; mentions?: string[] }> = [];
  let next = 1;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url !== "/api/messages/send") { response.end('{"uid":363}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { client_msg_id: string; topic_id: string; mentions?: string[] };
    requestBodies.push(body);
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
    const input = { topicId: "grp_1", clientMsgId: "run_x:phase:0:action", text: "hello", targetAgentUid: 553 };
    const first = await client.sendMessage(input);
    const second = await client.sendMessage(input);
    assert.equal(first.id, second.id);
    assert.equal(second.duplicate, true);
    assert.equal(seen.size, 1);
    assert.deepEqual(requestBodies.map((body) => body.mentions), [["usr553"], ["usr553"]]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("message cursor walks latest-page offsets instead of truncating at 100", async () => {
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1,
    seq_id: index + 1,
    topic_id: "grp_1",
    from_uid: 553,
    content: `message-${index + 1}`,
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/messages") { response.statusCode = 404; response.end("{}"); return; }
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const descendingWindow = [...messages].reverse().slice(offset, offset + limit).reverse();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ messages: descendingWindow }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "catsloop-cursor-"));
  try {
    const cfg = config(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, root);
    cfg.catscoToken = "valid";
    const client = new CatscoClient(cfg, join(root, "token.json"));
    const fresh = await client.getMessagesAfter("grp_1", 50);
    assert.equal(fresh.length, 200);
    assert.equal(fresh[0]?.seq_id, 51);
    assert.equal(fresh.at(-1)?.seq_id, 250);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
