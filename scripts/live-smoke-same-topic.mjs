#!/usr/bin/env node
const base = process.env.CATSLOOP_CATSCO_BASE_URL;
const token = process.env.CATSLOOP_CATSCO_TOKEN;
const agentUid = Number(process.env.CATSLOOP_SMOKE_AGENT_UID || 0);
if (!base || !token || !agentUid) throw new Error("CATSLOOP_CATSCO_BASE_URL, CATSLOOP_CATSCO_TOKEN and CATSLOOP_SMOKE_AGENT_UID are required");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function api(path, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, headers: { ...headers, ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.error || ""}`);
  return body;
}
async function status(topic) {
  const body = await api("/api/conversations");
  return body.conversations.find((item) => item.id === topic)?.task_status;
}
async function waitTerminal(topic, previousRunId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = await status(topic);
    if (current?.run_id && current.run_id !== previousRunId && ["completed", "failed", "cancelled", "stale"].includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Timed out waiting for a new terminal Episode");
}

const stamp = Date.now();
const task = await api("/api/groups/create", { method: "POST", body: JSON.stringify({ name: `Loop same-topic smoke ${stamp}`, member_ids: [agentUid], kind: "agent_task" }) });
const topic = task.topic;
const firstId = `catsloop-smoke-${stamp}-1`;
await api("/api/messages/send", { method: "POST", body: JSON.stringify({ topic_id: topic, client_msg_id: firstId, content: "Reply only EPISODE_ONE_OK. Do not use tools.", msg_type: "text" }) });
const first = await waitTerminal(topic, undefined);
const secondId = `catsloop-smoke-${stamp}-2`;
await api("/api/messages/send", { method: "POST", body: JSON.stringify({ topic_id: topic, client_msg_id: secondId, content: "Reply only EPISODE_TWO_OK. This is a second turn in the same Topic. Do not use tools.", msg_type: "text" }) });
const second = await waitTerminal(topic, first.run_id);
if (first.run_id === second.run_id) throw new Error("Second turn reused the old Episode run ID");
console.log(JSON.stringify({ ok: true, topic, first_run_id: first.run_id, second_run_id: second.run_id }, null, 2));
