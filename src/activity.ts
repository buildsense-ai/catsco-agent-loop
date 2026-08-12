import type { AgentTurnState, LoopRun, RunPhase } from "./types.js";

export const DEFAULT_ACTIVITY_STALL_MS = 20 * 60_000;

const AGENT_PHASES = new Set<RunPhase>(["monday_finding", "developer_implementing", "monday_review"]);
const TERMINAL_PHASES = new Set<RunPhase>(["paused", "blocked", "blocked_auth", "blocked_github_auth", "cancelled", "completed"]);

export function activityAgent(run: LoopRun): AgentTurnState | undefined {
  if (TERMINAL_PHASES.has(run.phase)) return undefined;
  const phase = run.phase === "recovering" ? run.resume_phase : run.phase;
  if (!phase || !AGENT_PHASES.has(phase)) return undefined;
  return phase === "developer_implementing" ? run.developer : run.monday;
}

export function computeActivityState(run: LoopRun, at = Date.now(), stallMs = DEFAULT_ACTIVITY_STALL_MS): LoopRun["activity_state"] {
  const agent = activityAgent(run);
  if (!agent?.topic_id) return "quiet";
  const lastActivity = Date.parse(run.last_activity_at);
  if (Number.isFinite(lastActivity) && at - lastActivity >= stallMs) return "suspected_stall";
  return agent.episode?.state === "running" ? "active" : "quiet";
}
