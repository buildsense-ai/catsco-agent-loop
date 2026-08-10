import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LoopController } from "./controller.js";
import type { RunStore } from "./store.js";
import type { CreateRunInput } from "./types.js";

const MAX_BODY = 1024 * 1024;

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store" });
  response.end(encoded);
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function createLoopApi(controller: LoopController, store: RunStore) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const origin = request.headers.origin;
      if (origin && origin !== controller.config.allowedOrigin) throw new HttpError(403, "origin not allowed");
      if (origin && controller.config.allowedOrigin && origin === controller.config.allowedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-allow-headers", "authorization,content-type");
        response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname === "/health") {
        send(response, 200, { ok: true, service: "catsco-agent-loop" });
        return;
      }
      if (bearer(request) !== controller.config.operatorToken) throw new HttpError(401, "unauthorized");

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await jsonBody(request) as CreateRunInput;
        send(response, 201, await controller.createRun(body));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        send(response, 200, { runs: await store.listRuns() });
        return;
      }
      const match = url.pathname.match(/^\/api\/runs\/(run_[A-Za-z0-9_-]+)(?:\/(events|resume|reconcile|cancel))?$/);
      if (!match) throw new HttpError(404, "not found");
      const runId = match[1]!;
      const action = match[2];
      if (request.method === "GET" && !action) {
        send(response, 200, await store.readRun(runId));
        return;
      }
      if (request.method === "GET" && action === "events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        send(response, 200, { events: await store.readEvents(runId, Number.isFinite(after) ? after : 0) });
        return;
      }
      if (request.method === "POST" && action === "resume") {
        send(response, 200, await controller.resume(runId));
        return;
      }
      if (request.method === "POST" && action === "reconcile") {
        send(response, 200, await controller.reconcile(runId));
        return;
      }
      if (request.method === "POST" && action === "cancel") {
        send(response, 200, await controller.cancel(runId));
        return;
      }
      throw new HttpError(405, "method not allowed");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
      send(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return {
    server,
    async listen(host: string, port: number): Promise<AddressInfo> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
      return server.address() as AddressInfo;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
