#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const base = process.env.CATSLOOP_API_URL ?? "http://127.0.0.1:19992";
  const token = process.env.CATSLOOP_OPERATOR_TOKEN;
  if (!token) throw new Error("CATSLOOP_OPERATOR_TOKEN is required");
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
  return data;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  let result: unknown;
  switch (command) {
    case "start": {
      const requestText = option("request-file") ? await readFile(required("request-file"), "utf8") : required("request");
      result = await request("/api/runs", "POST", {
        request: requestText,
        repo: required("repo"),
        base_branch: option("base") ?? "main",
        ...(option("monday-uid") ? { monday_agent_uid: Number(option("monday-uid")) } : {}),
        ...(option("developer-uid") ? { developer_agent_uid: Number(option("developer-uid")) } : {}),
      });
      break;
    }
    case "list": result = await request("/api/runs"); break;
    case "status": result = await request(`/api/runs/${required("run")}`); break;
    case "resume": result = await request(`/api/runs/${required("run")}/resume`, "POST"); break;
    case "reconcile": result = await request(`/api/runs/${required("run")}/reconcile`, "POST"); break;
    case "cancel": result = await request(`/api/runs/${required("run")}/cancel`, "POST"); break;
    default:
      throw new Error("Usage: loopctl start|list|status|resume|reconcile|cancel [options]");
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
