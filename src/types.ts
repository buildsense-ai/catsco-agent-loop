export type RunPhase =
  | "queued"
  | "monday_finding"
  | "developer_implementing"
  | "waiting_ci"
  | "monday_review"
  | "recovering"
  | "blocked"
  | "blocked_auth"
  | "blocked_github_auth"
  | "cancelled"
  | "completed";

export type Actor = "controller" | "monday" | "developer" | "github" | "none";

export interface EpisodeStatus {
  topic_id: string;
  run_id?: string;
  state: "running" | "waiting" | "completed" | "failed" | "cancelled" | "stale" | string;
  summary?: string;
  error?: string;
  source_uid?: number;
  updated_at?: string;
}

export interface AgentTurnState {
  agent_uid: number;
  topic_id?: string;
  group_id?: number;
  dispatch_seq?: number;
  dispatch_message_id?: number;
  previous_episode_run_id?: string;
  episode?: EpisodeStatus;
  episode_observed_at?: string;
  episode_started: boolean;
  last_agent_seq?: number;
  last_observed_seq?: number;
  last_prompt_key?: string;
  protocol_error?: string;
  github_auth_error?: string;
}

export interface FindingRecord {
  version: number;
  id: string;
  name: string;
  url: string;
  source_message_id: number;
  source_topic_id: string;
  size: number;
  sha256: string;
  stored_path: string;
  created_at?: string;
  validated_at: string;
}

export interface PullRequestState {
  number: number;
  url: string;
  state: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  author_login: string;
  head_repository: string;
  head_repository_owner: string;
  expected_previous_sha?: string;
  first_seen_at: string;
}

export type CiState = "pending" | "success" | "failure" | "none";

export interface CiSummary {
  sha: string;
  state: CiState;
  checks: Array<{ name: string; state: string; conclusion?: string; url?: string }>;
  observed_at: string;
  first_empty_at?: string;
}

export interface DispatchReceipt {
  key: string;
  topic_id: string;
  message_id: number;
  seq_id: number;
  client_msg_id: string;
  sent_at: string;
}

export interface LoopRun {
  schema_version: 1;
  run_id: string;
  phase: RunPhase;
  resume_phase?: Exclude<RunPhase, "recovering">;
  active_actor: Actor;
  waiting_for: string;
  iteration: number;
  monday_attempt: number;
  developer_attempt: number;
  recovery_attempt: number;
  request: string;
  repo: string;
  base_branch: string;
  branch: string;
  monday_github_login: string;
  developer_github_login: string;
  monday: AgentTurnState;
  developer: AgentTurnState;
  pr?: PullRequestState;
  ci?: CiSummary;
  latest_finding?: FindingRecord;
  pending_review_finding?: FindingRecord;
  review_requested_at?: string;
  review_dispatch_seq?: number;
  review_baseline_comment_ids: string[];
  sent_message_ids: number[];
  receipts: Record<string, DispatchReceipt>;
  paused_for_manual_message?: { topic_id: string; message_id: number; detected_at: string };
  created_at: string;
  updated_at: string;
  last_progress_at: string;
  github_polled_at?: string;
  next_retry_at?: string;
  last_error?: string;
  terminal_reason?: string;
  cancel_requested: boolean;
}

export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  phase: RunPhase;
  actor: Actor;
  message: string;
  data?: Record<string, unknown>;
}

export interface CreateRunInput {
  request: string;
  repo: string;
  base_branch?: string;
  monday_agent_uid?: number;
  developer_agent_uid?: number;
  monday_github_login?: string;
  developer_github_login?: string;
}

export interface CatscoFile {
  id: string;
  name: string;
  url: string;
  file_key?: string;
  mime_type?: string;
  size?: number;
  message_id: number;
  topic_id: string;
  created_at?: string;
  block_index?: number;
}

export interface CatscoMessage {
  id: number;
  seq_id?: number;
  topic_id: string;
  from_uid: number;
  content?: unknown;
  content_blocks?: Array<Record<string, unknown>>;
  client_msg_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface SendMessageInput {
  topicId: string;
  clientMsgId: string;
  text: string;
  files?: Array<{ name: string; url: string; fileKey?: string; mimeType?: string; size?: number }>;
}

export interface SendMessageResult {
  id: number;
  seq_id: number;
  topic_id: string;
  client_msg_id?: string;
  duplicate?: boolean;
}

export interface ReviewEvidence {
  id: string;
  kind: "review" | "issue_comment" | "review_comment";
  author: string;
  state?: string;
  commit_id?: string;
  created_at: string;
  url?: string;
}

export interface ControllerConfig {
  catscoBaseUrl: string;
  catscoToken?: string;
  catscoAccount?: string;
  catscoPassword?: string;
  controllerUid: number;
  mondayAgentUid: number;
  developerAgentUid: number;
  mondayGithubLogin: string;
  developerGithubLogin: string;
  stateDir: string;
  host: string;
  port: number;
  operatorToken: string;
  allowedOrigin?: string;
  maxActiveRuns: number;
  catscoPollMs: number;
  githubPollMs: number;
  idlePollMs: number;
  noChecksGraceMs: number;
  stageTimeoutMs: number;
  maxFindingBytes: number;
}
