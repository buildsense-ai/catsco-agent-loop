import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = await mkdtemp(join(tmpdir(), "start-agent-loop-"));
const requestFile = join(root, "request.md");
const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
if (!skill.includes("node <SKILL_DIR>/scripts/start-loop.mjs")) {
  throw new Error("Skill must invoke the launcher through the absolute <SKILL_DIR> placeholder");
}
await writeFile(requestFile, "实现并验证这个需求\n", "utf8");
let captured;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  captured = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  response.writeHead(201, { "content-type": "application/json" });
  response.end(JSON.stringify({ run_id: "run_test", phase: "queued" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();

const child = spawn(process.execPath, [
  new URL("./start-loop.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  "--request-file", requestFile,
  "--repo", "buildsense-ai/example",
  "--idempotency-key", "message-12345",
], {
  env: { ...process.env, CATSLOOP_API_URL: `http://127.0.0.1:${address.port}`, CATSLOOP_OPERATOR_TOKEN: "secret", CATSLOOP_ARTIFACT_URL: "https://artifact.example" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = ""; let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const code = await new Promise((resolve) => child.once("exit", resolve));
server.close();

assert.equal(code, 0, stderr);
assert.deepEqual(captured.body, { request: "实现并验证这个需求", repo: "buildsense-ai/example" });
assert.equal(captured.headers["idempotency-key"], "message-12345");
const output = JSON.parse(stdout);
assert.deepEqual(output, { run_id: "run_test", phase: "queued", artifact_url: "https://artifact.example/?run=run_test" });
console.log("start-agent-loop smoke test passed");
