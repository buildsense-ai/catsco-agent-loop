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

## Checking Run status

Both checks below are read-only and require the operator token:

```bash
export CATSLOOP_OPERATOR_TOKEN=...
loopctl status --run run_...
curl -H "Authorization: Bearer $CATSLOOP_OPERATOR_TOKEN" \
  "${CATSLOOP_API_URL:-http://127.0.0.1:19992}/api/runs/run_.../events?after=0"
```

`loopctl status` reads the current Run record. The events `GET` returns events with a sequence greater than `after`; advance that value to poll incrementally. Neither check creates, resumes, reconciles, or cancels a Run.

An ordinary Monday ZIP does not automatically trigger a Run. Create a Run explicitly with `loopctl start` or `POST /api/runs`; a valid Finding ZIP is a delivery for an existing Run's Monday phase.

## Invariants

- A run exists only after explicit `POST /api/runs` or `loopctl start`.
- Each run creates exactly one Monday Agent Task and one Developer Agent Task, then reuses their Topics.
- Every logical send has a stable `client_msg_id`; retries cannot duplicate messages.
- A new Episode run ID is expected after each continuation, while the Topic and Controller Run stay fixed.
- A valid Finding ZIP is downloaded, SHA-256 hashed, path-checked, and required to contain `FINDING.md` and `manifest.json`.
- A revision requires the same PR and a new Head SHA.
- CI failure is returned to Developer; Controller does not rerun workflows.
- Continue requires both Monday GitHub feedback and a new Finding ZIP.
- Completion requires Monday `APPROVED` on the current Head SHA after CI success/no-check confirmation.
- New commits invalidate prior CI and approvals.
- Controller never merges, closes, or comments on the PR.

State is stored as atomic `run.json`, append-only `events.jsonl`, `request.md`, and validated ZIP copies below the configured run directory. On restart the scheduler reconciles external side effects before any resend.

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
