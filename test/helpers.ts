import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ICatscoClient } from "../src/catsco-client.js";
import type { IGithubClient } from "../src/github-client.js";
import type {
  CatscoFile,
  CatscoMessage,
  CiSummary,
  EpisodeStatus,
  PullRequestState,
  ReviewEvidence,
  SendMessageInput,
  SendMessageResult,
} from "../src/types.js";

export class FakeCatsco implements ICatscoClient {
  nextGroup = 2000;
  nextMessage = 10_000;
  topics = new Map<string, { agentUid: number; messages: CatscoMessage[]; files: CatscoFile[]; episode?: EpisodeStatus }>();
  fixtureZip?: string;
  validateError?: Error;
  sentInputs: SendMessageInput[] = [];

  async validateSession() {
    if (this.validateError) throw this.validateError;
    return { uid: 363, username: "controller" };
  }

  async findAgentTask(name: string, agentUid: number) {
    for (const [topicId, topic] of this.topics) {
      const storedName = (topic as typeof topic & { name?: string }).name;
      if (storedName === name && topic.agentUid === agentUid) return { group_id: Number(topicId.slice(4)), topic: topicId };
    }
    return undefined;
  }

  async createAgentTask(name: string, agentUid: number) {
    const group = this.nextGroup++;
    const topic = `grp_${group}`;
    this.topics.set(topic, { agentUid, messages: [], files: [], name } as { agentUid: number; messages: CatscoMessage[]; files: CatscoFile[]; episode?: EpisodeStatus });
    return { group_id: group, topic };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.sentInputs.push(structuredClone(input));
    const topic = this.topics.get(input.topicId)!;
    const existing = topic.messages.find((message) => message.client_msg_id === input.clientMsgId);
    if (existing) return { id: existing.id, seq_id: existing.id, topic_id: input.topicId, client_msg_id: input.clientMsgId, duplicate: true };
    const id = this.nextMessage++;
    topic.messages.push({
      id,
      seq_id: id,
      topic_id: input.topicId,
      from_uid: 363,
      content: input.text,
      client_msg_id: input.clientMsgId,
      metadata: input.targetAgentUid ? { mentions: [`usr${input.targetAgentUid}`] } : undefined,
    });
    return { id, seq_id: id, topic_id: input.topicId, client_msg_id: input.clientMsgId, duplicate: false };
  }

  async getMessages(topicId: string) { return [...(this.topics.get(topicId)?.messages ?? [])]; }
  async getMessagesAfter(topicId: string, afterSeq: number) {
    return [...(this.topics.get(topicId)?.messages ?? [])]
      .filter((message) => Number(message.seq_id ?? message.id) > afterSeq)
      .sort((a, b) => Number(a.seq_id ?? a.id) - Number(b.seq_id ?? b.id));
  }
  async getAgentFiles(_agentUid: number, topicId: string) { return [...(this.topics.get(topicId)?.files ?? [])]; }
  async getEpisode(topicId: string) { return this.topics.get(topicId)?.episode; }

  async download(_url: string, destination: string) {
    if (!this.fixtureZip) throw new Error("fixture zip missing");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.fixtureZip, destination);
    const buffer = await import("node:fs/promises").then(({ readFile }) => readFile(destination));
    return { size: (await stat(destination)).size, sha256: createHash("sha256").update(buffer).digest("hex") };
  }

  finish(topicId: string, state = "completed") {
    const topic = this.topics.get(topicId)!;
    topic.episode = { topic_id: topicId, run_id: `episode_${this.nextMessage}`, state, source_uid: topic.agentUid, updated_at: new Date().toISOString() };
  }

  agentReply(topicId: string, text: string, contentBlocks?: Array<Record<string, unknown>>) {
    const topic = this.topics.get(topicId)!;
    const id = this.nextMessage++;
    topic.messages.push({ id, seq_id: id, topic_id: topicId, from_uid: topic.agentUid, content: text, ...(contentBlocks ? { content_blocks: contentBlocks } : {}) });
    return id;
  }

  addFinding(topicId: string, name = "finding.zip") {
    const topic = this.topics.get(topicId)!;
    const messageId = this.agentReply(topicId, "Finding attached");
    topic.files.push({ id: `${messageId}:0`, name, url: "https://cats.example/uploads/files/finding.zip", mime_type: "application/zip", size: 123, message_id: messageId, topic_id: topicId, created_at: new Date().toISOString() });
  }
}

export class FakeGithub implements IGithubClient {
  pr?: PullRequestState;
  ci: CiSummary = { sha: "", state: "pending", checks: [], observed_at: new Date().toISOString() };
  evidence: ReviewEvidence[] = [];
  validateCalls = 0;
  findCalls = 0;
  ciCalls = 0;
  reviewCalls = 0;
  defaultBranch = "main";

  async validate() { this.validateCalls += 1; return { login: "controller" }; }
  async getDefaultBranch() { return this.defaultBranch; }
  async findPullRequest() { this.findCalls += 1; return this.pr ? { ...this.pr } : undefined; }
  async getCi(_repo: string, sha: string) { this.ciCalls += 1; return { ...this.ci, sha }; }
  async getReviewEvidence() { this.reviewCalls += 1; return [...this.evidence]; }
}
