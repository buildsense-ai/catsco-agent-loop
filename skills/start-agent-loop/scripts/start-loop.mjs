#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const requestFile = required("request-file");
const repo = required("repo");
const idempotencyKey = required("idempotency-key");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("--repo must be owner/name");

const apiUrl = process.env.CATSLOOP_API_URL ?? "http://127.0.0.1:19992";
const token = process.env.CATSLOOP_OPERATOR_TOKEN;
if (!token) throw new Error("CATSLOOP_OPERATOR_TOKEN is not configured");
const request = (await readFile(requestFile, "utf8")).trim();
if (!request) throw new Error("request file is empty");

export async function startLoop(fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/api/runs", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ request, repo }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Controller returned HTTP ${response.status}`);

  const artifactBase = process.env.CATSLOOP_ARTIFACT_URL?.replace(/\/$/, "");
  return {
    run_id: body.run_id,
    phase: body.phase,
    ...(artifactBase ? { artifact_url: `${artifactBase}/?run=${encodeURIComponent(body.run_id)}` } : {}),
  };
}

console.log(JSON.stringify(await startLoop(), null, 2));
