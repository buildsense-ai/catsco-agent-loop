import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CATSLOOP_CATSCO_BASE_URL: "https://cats.example",
    CATSLOOP_CATSCO_TOKEN: "token",
    CATSLOOP_MONDAY_GITHUB_LOGIN: "monday",
    CATSLOOP_DEVELOPER_GITHUB_LOGIN: "developer",
    CATSLOOP_OPERATOR_TOKEN: "operator",
    ...overrides,
  };
}

test("loadConfig exposes 90 minute mechanical, 20 minute activity, and 4 hour absolute defaults", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.stageTimeoutMs, 90 * 60_000);
  assert.equal(config.activityStallMs, 20 * 60_000);
  assert.equal(config.runAbsoluteTimeoutMs, 4 * 60 * 60_000);
});

test("loadConfig accepts positive timing overrides and rejects non-positive values", () => {
  const overridden = loadConfig(baseEnv({
    CATSLOOP_STAGE_TIMEOUT_MS: "123",
    CATSLOOP_ACTIVITY_STALL_MS: "456",
    CATSLOOP_RUN_ABSOLUTE_TIMEOUT_MS: "789",
  }));
  assert.equal(overridden.stageTimeoutMs, 123);
  assert.equal(overridden.activityStallMs, 456);
  assert.equal(overridden.runAbsoluteTimeoutMs, 789);

  const fallback = loadConfig(baseEnv({
    CATSLOOP_STAGE_TIMEOUT_MS: "0",
    CATSLOOP_ACTIVITY_STALL_MS: "-1",
    CATSLOOP_RUN_ABSOLUTE_TIMEOUT_MS: "invalid",
  }));
  assert.equal(fallback.stageTimeoutMs, 90 * 60_000);
  assert.equal(fallback.activityStallMs, 20 * 60_000);
  assert.equal(fallback.runAbsoluteTimeoutMs, 4 * 60 * 60_000);
});
