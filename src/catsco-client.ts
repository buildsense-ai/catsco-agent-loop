import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CatscoAuthError, LoopError } from "./errors.js";
import type {
  CatscoFile,
  CatscoMessage,
  ControllerConfig,
  EpisodeStatus,
  SendMessageInput,
  SendMessageResult,
} from "./types.js";

const RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000];

interface RequestOptions extends RequestInit {
  retry?: boolean;
  allowLogin?: boolean;
}

export interface ICatscoClient {
  validateSession(): Promise<{ uid: number; username?: string }>;
  findAgentTask(name: string, agentUid: number): Promise<{ group_id: number; topic: string } | undefined>;
  createAgentTask(name: string, agentUid: number): Promise<{ group_id: number; topic: string }>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getMessages(topicId: string, limit?: number): Promise<CatscoMessage[]>;
  getMessagesAfter(topicId: string, afterSeq: number, maxMessages?: number): Promise<CatscoMessage[]>;
  getAgentFiles(agentUid: number, topicId: string): Promise<CatscoFile[]>;
  getEpisode(topicId: string): Promise<EpisodeStatus | undefined>;
  download(url: string, destination: string, maxBytes: number): Promise<{ size: number; sha256: string }>;
}

export class CatscoClient implements ICatscoClient {
  private token: string | undefined;

  constructor(
    private readonly config: ControllerConfig,
    private readonly tokenCachePath: string,
  ) {
    this.token = config.catscoToken;
  }

  async loadCachedToken(): Promise<void> {
    try {
      const cached = JSON.parse(await readFile(this.tokenCachePath, "utf8")) as { token?: string };
      if (cached.token) this.token = cached.token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async validateSession(): Promise<{ uid: number; username?: string }> {
    await this.loadCachedToken();
    return await this.request("/api/me") as { uid: number; username?: string };
  }

  async createAgentTask(name: string, agentUid: number): Promise<{ group_id: number; topic: string }> {
    return await this.request("/api/groups/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, member_ids: [agentUid], kind: "agent_task" }),
    }) as { group_id: number; topic: string };
  }

  async findAgentTask(name: string, agentUid: number): Promise<{ group_id: number; topic: string } | undefined> {
    const response = await this.request("/api/conversations") as {
      conversations?: Array<{ id?: string; name?: string; group_id?: number; is_agent_task?: boolean; agent_ids?: number[] }>;
    };
    const found = response.conversations?.find((item) => item.name === name && item.is_agent_task === true && item.agent_ids?.length === 1 && item.agent_ids[0] === agentUid);
    if (!found?.id || !found.group_id) return undefined;
    return { group_id: found.group_id, topic: found.id };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const contentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: input.text }];
    for (const file of input.files ?? []) {
      contentBlocks.push({
        type: "file",
        payload: {
          name: file.name,
          url: file.url,
          ...(file.fileKey ? { file_key: file.fileKey } : {}),
          ...(file.mimeType ? { mime_type: file.mimeType } : {}),
          ...(file.size !== undefined ? { size: file.size } : {}),
        },
      });
    }
    return await this.request("/api/messages/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic_id: input.topicId,
        client_msg_id: input.clientMsgId,
        content: input.text,
        content_blocks: contentBlocks,
        ...(input.targetAgentUid ? { mentions: [`usr${input.targetAgentUid}`] } : {}),
        mode: "code",
        role: "user",
        msg_type: "text",
        metadata: { loop_controller: true },
      }),
    }) as SendMessageResult;
  }

  async getMessages(topicId: string, limit = 100): Promise<CatscoMessage[]> {
    const all: CatscoMessage[] = [];
    for (let offset = 0; all.length < limit; offset += 100) {
      const query = new URLSearchParams({ topic_id: topicId, latest: "1", limit: String(Math.min(limit, 100)) });
      query.set("offset", String(offset));
      const response = await this.request(`/api/messages?${query}`) as { messages?: CatscoMessage[] };
      const page = response.messages ?? [];
      all.push(...page);
      if (page.length < Math.min(limit, 100)) break;
    }
    return all.sort((a, b) => a.id - b.id).slice(-limit);
  }

  async getMessagesAfter(topicId: string, afterSeq: number, maxMessages = 2_000): Promise<CatscoMessage[]> {
    const fresh: CatscoMessage[] = [];
    for (let offset = 0; offset < maxMessages; offset += 100) {
      const query = new URLSearchParams({ topic_id: topicId, latest: "1", limit: "100", offset: String(offset) });
      const response = await this.request(`/api/messages?${query}`) as { messages?: CatscoMessage[] };
      const page = response.messages ?? [];
      fresh.push(...page.filter((message) => Number(message.seq_id ?? message.id) > afterSeq));
      const crossedCursor = page.some((message) => Number(message.seq_id ?? message.id) <= afterSeq);
      if (crossedCursor || page.length < 100) break;
      if (offset + 100 >= maxMessages) {
        throw new LoopError(`CatsCompany message delta exceeded ${maxMessages} records for ${topicId}`, "message_cursor_overflow");
      }
    }
    return [...new Map(fresh.map((message) => [message.id, message])).values()]
      .sort((a, b) => Number(a.seq_id ?? a.id) - Number(b.seq_id ?? b.id));
  }

  async getAgentFiles(agentUid: number, topicId: string): Promise<CatscoFile[]> {
    const all: CatscoFile[] = [];
    let beforeId: number | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ topic_id: topicId, limit: "100" });
      if (beforeId) query.set("before_id", String(beforeId));
      const response = await this.request(`/api/agents/${agentUid}/files?${query}`) as {
        files?: CatscoFile[];
        has_more?: boolean;
        next_before_id?: number;
      };
      all.push(...(response.files ?? []));
      if (!response.has_more || !response.next_before_id) break;
      beforeId = response.next_before_id;
    }
    return all.sort((a, b) => a.message_id - b.message_id);
  }

  async getEpisode(topicId: string): Promise<EpisodeStatus | undefined> {
    const response = await this.request("/api/conversations") as {
      conversations?: Array<{ id?: string; task_status?: EpisodeStatus }>;
    };
    return response.conversations?.find((item) => item.id === topicId || item.task_status?.topic_id === topicId)?.task_status;
  }

  async download(url: string, destination: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const { createHash } = await import("node:crypto");
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    const parsed = new URL(url, this.config.catscoBaseUrl);
    const base = new URL(this.config.catscoBaseUrl);
    if (parsed.origin !== base.origin) throw new LoopError("Finding URL is outside CatsCompany origin", "unsafe_file_url");
    const response = await this.fetchDownload(parsed);
    if (!response.ok || !response.body) throw new LoopError(`Finding download failed: HTTP ${response.status}`, "download_failed", response.status >= 500);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new LoopError("Finding ZIP exceeds configured size limit", "finding_too_large");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let size = 0;
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new LoopError("Finding ZIP exceeds configured size limit", "finding_too_large");
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    });
    await pipeline(response.body.pipeThrough(transform), createWriteStream(destination, { mode: 0o600 }));
    return { size, sha256: hash.digest("hex") };
  }

  private authHeaders(): HeadersInit {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private async login(): Promise<void> {
    if (!this.config.catscoAccount || !this.config.catscoPassword) {
      throw new CatscoAuthError("CatsCompany token expired and no account/password fallback is configured");
    }
    const response = await fetch(new URL("/api/auth/login", this.config.catscoBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: this.config.catscoAccount, password: this.config.catscoPassword, persistent: true }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({})) as { token?: string; error?: string };
    if (!response.ok || !body.token) throw new CatscoAuthError(body.error ?? `CatsCompany login failed: HTTP ${response.status}`, response.status);
    this.token = body.token;
    await mkdir(dirname(this.tokenCachePath), { recursive: true, mode: 0o700 });
    await writeFile(this.tokenCachePath, `${JSON.stringify({ token: body.token, updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  }

  private async fetchDownload(url: URL): Promise<Response> {
    let loggedIn = false;
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
      try {
        const response = await fetch(url, { headers: this.authHeaders(), signal: AbortSignal.timeout(60_000) });
        if (response.status === 401 && !loggedIn) {
          await response.body?.cancel().catch(() => undefined);
          await this.login();
          loggedIn = true;
          attempt -= 1;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          const body = await response.clone().json().catch(() => ({})) as { error?: string };
          throw new CatscoAuthError(body.error ?? `CatsCompany download authorization failed: HTTP ${response.status}`, response.status);
        }
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < RETRY_DELAYS.length) {
          lastError = new LoopError(`Finding download failed: HTTP ${response.status}`, "download_failed", true, response.status);
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        return response;
      } catch (error) {
        if (error instanceof CatscoAuthError || (error instanceof LoopError && !error.retryable)) throw error;
        lastError = error;
        if (attempt >= RETRY_DELAYS.length) break;
      }
    }
    throw new LoopError(`Finding download failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, "download_failed", true);
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const retry = options.retry !== false;
    let loggedIn = false;
    let lastError: unknown;
    for (let attempt = 0; attempt <= (retry ? RETRY_DELAYS.length : 0); attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
      try {
        const headers = new Headers(options.headers);
        for (const [key, value] of Object.entries(this.authHeaders())) headers.set(key, String(value));
        const response = await fetch(new URL(path, this.config.catscoBaseUrl), {
          ...options,
          headers,
          signal: options.signal ?? AbortSignal.timeout(60_000),
        });
        if (response.status === 401 && !loggedIn && options.allowLogin !== false) {
          await this.login();
          loggedIn = true;
          attempt -= 1;
          continue;
        }
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401 || response.status === 403) throw new CatscoAuthError(body.error ?? `CatsCompany authorization failed: HTTP ${response.status}`, response.status);
        if (!response.ok) {
          const canRetry = response.status === 408 || response.status === 429 || response.status >= 500;
          if (canRetry && attempt < RETRY_DELAYS.length) {
            lastError = new LoopError(body.error ?? `CatsCompany HTTP ${response.status}`, "catsco_http", true, response.status);
            continue;
          }
          throw new LoopError(body.error ?? `CatsCompany HTTP ${response.status}`, "catsco_http", canRetry, response.status);
        }
        return body;
      } catch (error) {
        if (error instanceof CatscoAuthError || (error instanceof LoopError && !error.retryable)) throw error;
        lastError = error;
        if (attempt >= RETRY_DELAYS.length) break;
      }
    }
    throw new LoopError(`CatsCompany request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, "catsco_network", true);
  }
}
