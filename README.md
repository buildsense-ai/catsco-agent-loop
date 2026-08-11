# CatsCompany Agent Loop

Minimal external controller for a two-agent implementation loop:

```text
explicit request → Monday Finding ZIP → Developer PR → CI → Monday review
                                                  ↑              │
                                                  └─ comment+ZIP ┘
                                                        APPROVED → stop
```

The Controller owns orchestration state. It does not modify CatsCompany, XiaoBa, Monday, or Developer; it never merges or closes a pull request. Agent prose is not completion evidence: CatsCompany files/Episodes and GitHub PR/SHA/check/review records are.

## Runtime

- Node.js 20+
- `gh` authenticated with read access to target repositories
- CatsCompany persistent user token, or account/password fallback
- one configured Monday GitHub login and a different Developer GitHub login

The direct-prompt controller requires a general-purpose coding Agent. A strict `execute_attempt` worker that requires `LOOP_WORKTREE_CONTRACT_V1`, workspace leases, and native candidate events belongs to the separate A2A Harness and is rejected explicitly instead of being retried with incomplete prompts.

```bash
cp .env.example .env
npm ci
npm run build
set -a; . ./.env; set +a
npm start
```

The API listens on `127.0.0.1:19992` by default. Every `/api/*` request requires `Authorization: Bearer $CATSLOOP_OPERATOR_TOKEN`.

```bash
export CATSLOOP_OPERATOR_TOKEN=...
loopctl start --repo buildsense-ai/example --base main --request "Implement ..."
loopctl list
loopctl status --run run_...
loopctl reconcile --run run_...
loopctl resume --run run_...
loopctl cancel --run run_...
```

## Invariants

- A run exists only after explicit `POST /api/runs` or `loopctl start`.
- Each run creates exactly one Monday Agent Task and one Developer Agent Task, then reuses their Topics.
- Every logical send has a stable `client_msg_id`; retries cannot duplicate messages.
- A new Episode run ID is expected after each continuation, while the Topic and Controller Run stay fixed.
- A valid Finding ZIP is downloaded, SHA-256 hashed, path-checked, and required to contain `FINDING.md` and `manifest.json`.
- A revision requires the same PR and a new Head SHA.
- The PR author must match the configured Developer GitHub login and the head repository must be the controlled repository.
- CI failure is returned to Developer; Controller does not rerun workflows.
- Continue requires both Monday GitHub feedback and a new Finding ZIP.
- Each Monday review attempt has a durable Review Cycle bound to one PR number and exact Head SHA. Its baseline GitHub evidence, Finding ZIP, and review/comment are scoped to that cycle only.
- Superseded Review Cycles and their ZIPs remain in `review_cycles` and `finding_history` for operator/Artifact disclosure; they can never pair with evidence from a later Head.
- Completion requires Monday `APPROVED` on the current Head SHA after CI success/no-check confirmation.
- New commits invalidate prior CI and approvals.
- Controller never merges, closes, or comments on the PR.

State is stored as atomic `run.json`, append-only `events.jsonl`, `request.md`, and validated ZIP copies below the configured run directory. On restart the scheduler reconciles external side effects before any resend.
Episode state is a timestamped observation; `active_actor` is authoritative for who the Controller is currently driving.
Before the HTTP API and scheduler start, the Controller performs an idempotent migration that adds missing timing and Review Cycle disclosure fields to legacy `run.json` files. Runtime GET/read paths remain side-effect free.

## Run timing

Every `run.json`, `GET /api/runs`, and `GET /api/runs/:id` discloses `activity_state`, `last_activity_at`, and `last_progress_at`.

- `last_activity_at` advances only for a new controlled-Agent message or a change to the observed Episode `run_id`, `state`, or `updated_at`. Polling, Controller messages, phase changes, and GitHub checks are not Agent activity.
- `activity_state` is `active` for a running Episode with recent activity, `quiet` for normal non-running/non-Agent waits, and `suspected_stall` after 20 minutes without qualifying activity while waiting for an Agent. A suspected stall is disclosure only: it does not resend, restart, or create a Topic.
- `last_progress_at` advances only for mechanical delivery evidence such as a validated Finding ZIP, an open PR or new Head SHA, terminal CI evidence, or a new review/comment/approval.
- The mechanical stage timeout defaults to 90 minutes. A running Episode is not blocked solely because that window elapsed, and a terminal Episode missing delivery retains the same-Topic 1/3/8/15-minute recovery schedule.
- The absolute Run limit defaults to four hours from immutable `created_at`, includes queued time, and can block as the final fallback. Resume resets both activity and mechanical windows but does not reset this absolute anchor.

The timing values are configurable with `stageTimeoutMs`, `activityStallMs`, and `runAbsoluteTimeoutMs`, or the corresponding `CATSLOOP_STAGE_TIMEOUT_MS`, `CATSLOOP_ACTIVITY_STALL_MS`, and `CATSLOOP_RUN_ABSOLUTE_TIMEOUT_MS` environment variables.

## API

```text
POST /api/runs
GET  /api/runs
GET  /api/runs/:id
GET  /api/runs/:id/events?after=<seq>
POST /api/runs/:id/resume
POST /api/runs/:id/reconcile
POST /api/runs/:id/cancel
```

The static operator console is in `artifact/`. It contains no credentials; the operator supplies the API token at runtime and the browser holds it in `sessionStorage`.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

`scripts/live-smoke-same-topic.mjs` validates the critical CatsCompany guarantee: two distinct messages sent to one Agent Task Topic produce two distinct Episodes without creating another conversation.
