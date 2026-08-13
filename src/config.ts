import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ControllerConfig } from "./types.js";

type PartialConfig = Partial<ControllerConfig>;

function int(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = int(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function boundedPositiveInt(value: unknown, fallback: number, maximum: number): number {
  return Math.min(positiveInt(value, fallback), maximum);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optional(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}

function readJson(path: string | undefined): PartialConfig {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PartialConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const file = readJson(env.CATSLOOP_CONFIG);
  const catscoToken = optional(env.CATSLOOP_CATSCO_TOKEN ?? file.catscoToken);
  const catscoAccount = optional(env.CATSLOOP_CATSCO_ACCOUNT ?? file.catscoAccount);
  const catscoPassword = optional(env.CATSLOOP_CATSCO_PASSWORD ?? file.catscoPassword);
  const allowedOrigin = optional(env.CATSLOOP_ALLOWED_ORIGIN ?? file.allowedOrigin);

  const config: ControllerConfig = {
    catscoBaseUrl: text(env.CATSLOOP_CATSCO_BASE_URL ?? file.catscoBaseUrl),
    controllerUid: int(env.CATSLOOP_CONTROLLER_UID ?? file.controllerUid, 363),
    mondayAgentUid: int(env.CATSLOOP_MONDAY_UID ?? file.mondayAgentUid, 553),
    developerAgentUid: int(env.CATSLOOP_DEVELOPER_UID ?? file.developerAgentUid, 365),
    mondayGithubLogin: text(env.CATSLOOP_MONDAY_GITHUB_LOGIN ?? file.mondayGithubLogin),
    developerGithubLogin: text(env.CATSLOOP_DEVELOPER_GITHUB_LOGIN ?? file.developerGithubLogin),
    stateDir: resolve(text(env.CATSLOOP_STATE_DIR ?? file.stateDir, "./.runtime/runs")),
    host: text(env.CATSLOOP_HOST ?? file.host, "127.0.0.1"),
    port: int(env.CATSLOOP_PORT ?? file.port, 19992),
    operatorToken: text(env.CATSLOOP_OPERATOR_TOKEN ?? file.operatorToken),
    // One Controller may drive a small number of fully isolated Runs. Keep a
    // hard ceiling so a configuration typo cannot fan out Agent Episodes.
    maxActiveRuns: boundedPositiveInt(env.CATSLOOP_MAX_ACTIVE_RUNS ?? file.maxActiveRuns, 2, 4),
    catscoPollMs: int(env.CATSLOOP_CATSCO_POLL_MS ?? file.catscoPollMs, 5_000),
    githubPollMs: int(env.CATSLOOP_GITHUB_POLL_MS ?? file.githubPollMs, 15_000),
    idlePollMs: int(env.CATSLOOP_IDLE_POLL_MS ?? file.idlePollMs, 30_000),
    noChecksGraceMs: int(env.CATSLOOP_NO_CHECKS_GRACE_MS ?? file.noChecksGraceMs, 30_000),
    stageTimeoutMs: positiveInt(env.CATSLOOP_STAGE_TIMEOUT_MS ?? file.stageTimeoutMs, 90 * 60_000),
    activityStallMs: positiveInt(env.CATSLOOP_ACTIVITY_STALL_MS ?? file.activityStallMs, 20 * 60_000),
    runAbsoluteTimeoutMs: positiveInt(env.CATSLOOP_RUN_ABSOLUTE_TIMEOUT_MS ?? file.runAbsoluteTimeoutMs, 4 * 60 * 60_000),
    maxFindingBytes: positiveInt(env.CATSLOOP_MAX_FINDING_BYTES ?? file.maxFindingBytes, 100 * 1024 * 1024),
    ...(catscoToken ? { catscoToken } : {}),
    ...(catscoAccount ? { catscoAccount } : {}),
    ...(catscoPassword ? { catscoPassword } : {}),
    ...(allowedOrigin ? { allowedOrigin } : {}),
  };

  const missing = [
    ["catscoBaseUrl", config.catscoBaseUrl],
    ["mondayGithubLogin", config.mondayGithubLogin],
    ["developerGithubLogin", config.developerGithubLogin],
    ["operatorToken", config.operatorToken],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
  if (!config.catscoToken && !(config.catscoAccount && config.catscoPassword)) {
    throw new Error("Configure CATSLOOP_CATSCO_TOKEN or CatsCompany account/password");
  }
  if (config.mondayGithubLogin.toLowerCase() === config.developerGithubLogin.toLowerCase()) {
    throw new Error("Monday and Developer GitHub logins must be different");
  }
  return config;
}
