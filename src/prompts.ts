import type { LoopRun } from "./types.js";

function capsule(run: LoopRun, role: "Monday" | "Developer", missing: string): string {
  return [
    "[Loop Controller Resume Capsule]",
    `Run: ${run.run_id}`,
    `Role: ${role}`,
    `Phase: ${run.phase}`,
    `Iteration: ${run.iteration}`,
    `Repository: ${run.repo}`,
    `Branch: ${run.branch}`,
    run.pr ? `PR: ${run.pr.url}` : "PR: not created yet",
    run.pr ? `Current Head SHA: ${run.pr.head_sha}` : "Current Head SHA: unavailable",
    run.review_cycle ? `Review Cycle: ${run.review_cycle.cycle} (bound to Head ${run.review_cycle.head_sha})` : "Review Cycle: not started",
    `Current missing mechanical delivery: ${missing}`,
    "Controller state is authoritative; continue this same task in this same conversation.",
  ].join("\n");
}

export function mondayFindingPrompt(run: LoopRun): string {
  return [
    capsule(run, "Monday", "a validated Finding ZIP"),
    "",
    "Implementation request:",
    run.request,
    "",
    "Investigate the repository and produce the normal Monday Finding ZIP. This turn is investigation and delivery only; do not implement code.",
    "The ZIP must contain FINDING.md and manifest.json. Attach the ZIP to this conversation.",
  ].join("\n");
}

export function developerPrompt(run: LoopRun, kind: "initial" | "revision" | "ci", detail?: string): string {
  const missing = kind === "initial" ? "an open pull request" : kind === "revision" ? "a new Head SHA on the existing PR" : "a new Head SHA fixing CI";
  return [
    capsule(run, "Developer", missing),
    "",
    kind === "initial" ? `Implementation request:\n${run.request}` : `Continue the existing implementation for iteration ${run.iteration}.`,
    detail ? `\nAdditional evidence:\n${detail}` : "",
    "",
    "This is a direct CatsCompany Agent Task driven by catsco-agent-loop. Do not invoke the legacy loopctl-worker Skill and do not require execute_attempt, workspaceLease, targetTopicId, runtime_started, or candidate_submitted contracts.",
    "Use this prompt, the attached Finding ZIP, and the repository/branch details below as the complete work contract.",
    `Use branch ${run.branch} and target ${run.base_branch}. Implement, test, commit, push, and create or update the same PR in ${run.repo}.`,
    "Do not merge or close the PR. A text-only completion message is not delivery; Controller verifies the GitHub PR, Head SHA, and CI.",
  ].filter(Boolean).join("\n");
}

export function mondayReviewPrompt(run: LoopRun): string {
  const checks = run.ci?.checks.length
    ? run.ci.checks.map((check) => `- ${check.name}: ${check.conclusion ?? check.state}${check.url ? ` (${check.url})` : ""}`).join("\n")
    : "- Repository has no observed checks after the configured grace period.";
  return [
    capsule(run, "Monday", "APPROVED on the current SHA, or both a GitHub review/comment and a new Finding ZIP"),
    "",
    `Review PR: ${run.pr?.url}`,
    `Review Cycle: ${run.review_cycle?.cycle}`,
    `Exact Head SHA: ${run.pr?.head_sha}`,
    `CI state: ${run.ci?.state}`,
    checks,
    "",
    `Required GitHub reviewer login: ${run.monday_github_login}`,
    `Forbidden for review writes: ${run.developer_github_login} (Developer/PR author identity)` ,
    `Before any GitHub write, verify the active gh identity and switch to ${run.monday_github_login}. If that credential is unavailable, do not use another login and do not substitute an issue comment; include this exact line in your final reply: LOOP_BLOCKED_GITHUB_AUTH reviewer=${run.monday_github_login}`,
    "",
    "Review the exact current Head SHA for this Review Cycle. If changes are needed, leave a GitHub review/comment with the Monday GitHub identity and attach a new Finding ZIP here; both deliveries belong only to this Cycle and Head.",
    "If requirements are satisfied, submit an APPROVED GitHub review against the current Head SHA. Do not merge.",
  ].join("\n");
}

export function supplementPrompt(run: LoopRun, role: "Monday" | "Developer", missing: string): string {
  const identity = role === "Monday"
    ? `For GitHub review writes, the required login is ${run.monday_github_login}; do not use Developer login ${run.developer_github_login}. Verify or switch gh identity before writing. Do not substitute an issue comment. If unavailable, include exactly: LOOP_BLOCKED_GITHUB_AUTH reviewer=${run.monday_github_login}`
    : `For implementation writes, use Developer login ${run.developer_github_login}. This is a direct CatsCompany Agent Task; do not invoke the legacy loopctl-worker Skill or demand execute_attempt/workspaceLease/targetTopicId contracts.`;
  return [capsule(run, role, missing), "", identity, `The prior Episode ended, but Controller still cannot verify: ${missing}.`, "Do not redo completed work. Reconcile existing side effects and provide only the missing mechanical delivery."].join("\n");
}

export function unstartedResumePrompt(run: LoopRun, role: "Monday" | "Developer", missing: string): string {
  const identity = role === "Monday"
    ? `For GitHub review writes, the required login is ${run.monday_github_login}; do not use Developer login ${run.developer_github_login}.`
    : `For implementation writes, use Developer login ${run.developer_github_login}. This is a direct CatsCompany Agent Task; do not invoke the legacy loopctl-worker Skill or demand execute_attempt/workspaceLease contracts.`;
  return [
    capsule(run, role, missing),
    "",
    identity,
    "Controller recorded the prior delivery, but never observed this Agent Episode start.",
    "Start or continue the task now in this same conversation. Reconcile any existing side effects before creating new ones.",
  ].join("\n");
}
