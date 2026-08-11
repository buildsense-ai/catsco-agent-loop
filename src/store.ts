import { appendFile, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeActivityState, DEFAULT_ACTIVITY_STALL_MS } from "./activity.js";
import type { LoopRun, RunEvent, RunPhase } from "./types.js";

const TERMINAL = new Set<RunPhase>([
  "blocked",
  "blocked_auth",
  "blocked_github_auth",
  "cancelled",
  "completed",
]);

function normalizeRun(run: LoopRun, activityStallMs: number): void {
  if (!run.last_activity_at) run.last_activity_at = run.last_progress_at || run.updated_at || run.created_at;
  run.activity_state = computeActivityState(run, Date.now(), activityStallMs);
  run.review_progress_evidence_ids ??= [];
  run.finding_history ??= [];
  run.review_cycles ??= [];

  for (const finding of [run.latest_finding, run.pending_review_finding]) {
    if (finding && !run.finding_history.some((item) => item.id === finding.id)) run.finding_history.push(finding);
  }

  // Legacy schema had one unscoped pending slot. Materialize one explicit
  // cycle so a restart can never silently pair that ZIP with a future Head.
  if (!run.review_cycle && run.review_requested_at && run.pr) {
    const cycleNumber = Math.max(1, run.iteration + 1);
    const isReviewActive = run.phase === "monday_review"
      || run.resume_phase === "monday_review" && ["recovering", "blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase);
    const pending = run.pending_review_finding
      ? { ...run.pending_review_finding, purpose: "review" as const, review_cycle: cycleNumber, head_sha: run.pr.head_sha }
      : undefined;
    if (pending) {
      run.pending_review_finding = pending;
      const index = run.finding_history.findIndex((item) => item.id === pending.id);
      if (index >= 0) run.finding_history[index] = pending;
      else run.finding_history.push(pending);
    }
    run.review_cycle = {
      cycle: cycleNumber,
      pr_number: run.pr.number,
      head_sha: run.pr.head_sha,
      requested_at: run.review_requested_at,
      ...(run.review_dispatch_seq ? { dispatch_seq: run.review_dispatch_seq } : {}),
      baseline_evidence_ids: [...(run.review_baseline_comment_ids ?? [])],
      status: isReviewActive ? "active" : run.phase === "completed" ? "approved" : "superseded",
      ...(pending ? { finding: pending } : {}),
      ...(!isReviewActive ? { completed_at: run.updated_at, completion_reason: "Migrated from legacy unscoped review state." } : {}),
    };
    run.review_cycles.push(run.review_cycle);
  }
}

export class RunStore {
  constructor(readonly root: string, readonly activityStallMs = DEFAULT_ACTIVITY_STALL_MS) {}

  runDir(runId: string): string {
    if (!/^run_[a-z0-9_-]+$/i.test(runId)) throw new Error("Invalid run id");
    return join(this.root, runId);
  }

  async initialize(run: LoopRun): Promise<void> {
    const dir = this.runDir(run.run_id);
    await mkdir(join(dir, "files"), { recursive: true, mode: 0o700 });
    await this.writeRun(run);
    await writeFile(join(dir, "request.md"), `${run.request.trim()}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(dir, "events.jsonl"), "", { encoding: "utf8", flag: "a", mode: 0o600 });
  }

  async writeRun(run: LoopRun): Promise<void> {
    const path = join(this.runDir(run.run_id), "run.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const handle = await open(temporary, "r");
    try {
      try {
        await handle.sync();
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async readRun(runId: string): Promise<LoopRun> {
    const run = JSON.parse(await readFile(join(this.runDir(runId), "run.json"), "utf8")) as LoopRun;
    normalizeRun(run, this.activityStallMs);
    return run;
  }

  /**
   * Persist fields introduced after the original run schema was deployed.
   * This must run during Controller initialization, before the API and
   * scheduler start, so no stale read snapshot can race a live Run update.
   */
  async migrateLegacyRuns(): Promise<string[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const migrated: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      try {
        const path = join(this.runDir(entry.name), "run.json");
        const run = JSON.parse(await readFile(path, "utf8")) as LoopRun;
        const before = JSON.stringify(run);
        normalizeRun(run, this.activityStallMs);
        let changed = false;
        if (!run.last_progress_at) {
          run.last_progress_at = run.updated_at || run.created_at;
          changed = true;
        }
        if (!run.last_activity_at) {
          run.last_activity_at = run.last_progress_at;
          changed = true;
        }
        if (!run.activity_state) {
          run.activity_state = computeActivityState(run, Date.now(), this.activityStallMs);
          changed = true;
        }
        if (run.schema_version !== 2) {
          run.schema_version = 2;
          changed = true;
        }
        if (JSON.stringify(run) !== before) changed = true;
        if (!changed) continue;
        await this.writeRun(run);
        migrated.push(run.run_id);
      } catch {
        // Preserve the existing tolerant store behavior: one malformed Run
        // must not hide healthy Runs or prevent the operator API from starting.
      }
    }
    return migrated;
  }

  async listRuns(): Promise<LoopRun[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = await readdir(this.root, { withFileTypes: true });
    const runs = await Promise.all(
      names.filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
        .map(async (entry) => {
          try {
            return await this.readRun(entry.name);
          } catch {
            return undefined;
          }
        }),
    );
    return runs.filter((run): run is LoopRun => Boolean(run))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listNonTerminal(): Promise<LoopRun[]> {
    return (await this.listRuns()).filter((run) => !TERMINAL.has(run.phase));
  }

  async appendEvent(run: LoopRun, event: Omit<RunEvent, "seq" | "at" | "phase" | "actor"> & Partial<Pick<RunEvent, "at" | "phase" | "actor">>): Promise<RunEvent> {
    const path = join(this.runDir(run.run_id), "events.jsonl");
    const existing = await this.readEvents(run.run_id);
    const record: RunEvent = {
      seq: (existing.at(-1)?.seq ?? 0) + 1,
      at: event.at ?? new Date().toISOString(),
      phase: event.phase ?? run.phase,
      actor: event.actor ?? run.active_actor,
      type: event.type,
      message: event.message,
      ...(event.data ? { data: event.data } : {}),
    };
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return record;
  }

  async readEvents(runId: string, after = 0): Promise<RunEvent[]> {
    try {
      const content = await readFile(join(this.runDir(runId), "events.jsonl"), "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RunEvent)
        .filter((event) => event.seq > after);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async findingPath(runId: string, version: number): Promise<string> {
    const path = join(this.runDir(runId), "files", `finding-v${version}.zip`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return path;
  }
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL.has(phase);
}
