# QuotaFlow

[简体中文](README.md) · [Roadmap](ROADMAP.md#english) · [Contributor guide](AGENTS.md)

QuotaFlow schedules AI software development tasks using account quotas, concurrency limits, and budgets. It runs Codex or OpenCode in dedicated Git worktrees and saves checkpoints so interrupted work can resume.

**Status as of 2026-11-28.** Phase 0 passed its technical gate with conditions. Phase 1 has three-platform supervision, checkpoint recovery, budget audits, and optional handoff notes. Phase 2 completed its core loop: current-head CI, independent review, Draft and mandatory human merge gates, signed webhooks, two-level idempotency, bounded task materialization, read-only review, bot approval, CI log classification, same-SHA bounded reruns, and a real CI repair cycle. The repository owner merged PR [#141](https://github.com/wangxso/mcarplay/pull/141) into `main` at merge commit `23033142`. A controlled PR completed failure log → `ci_fix` task → free Magpie agent → checkpoint → published patch → passing follow-up CI → gate reevaluation. Lost-response recovery, duplicate deliveries, authorization rejection, and an isolated secret-rotation drill also passed. The stable endpoint is `https://quotaflow-hooks.wangxso.com/github/webhook`, supervised by macOS launchd with public health recovery. Phase 3 has a live Dashboard with project, time, Lane, and review-status combinations plus guarded `start`/`cancel`/`retry` actions backed by a session cookie, CSRF checks, explicit confirmation, idempotency, and audit events. Task details group Worker lifecycle events by `requestId` and provide correlated log access limited to the last 64 KiB with terminal-control cleanup and secret redaction. [Phase 1](docs/PHASE-1.md) · [Phase 2](docs/PHASE-2.md) · [Phase 3](docs/PHASE-3.md) · [filter evidence](docs/evidence/phase3-dashboard-filters-2026-11-28.json)

## Current capabilities

- **Scheduling.** SQLite v10 stores tasks, attempts, events, budget leases, GitHub gate records, and CI rerun claims. The scheduler reserves account concurrency slots, quota, and any configured budget in one transaction. `budget audit` reports expired leases, and an unknown hold created during recovery propagates to account cooldowns.
- **Execution and recovery.** The CLI can submit, inspect, cancel, and retry tasks. Windows uses Job Objects. The native macOS supervisor tracks roots, children, and process groups. Linux enables child-subreaper mode to adopt detached descendants and scans `/proc`. Checkpointing and recovery require an independently verified stop receipt. A launched supervised attempt with a missing receipt stays `blocked` and retains write ownership. Read-only tasks use the agent's native read-only policy and are rejected if their worktree changes. `--handoff` can pass a checkpoint-bound note to the next agent after an interruption.
- **Adapters and usage.** The default Codex App Server and OpenCode adapters support supervised execution on Windows, macOS, and Linux. Magpie routing requires explicit configuration approval. Gateway estimates back budget leases, and provider invoice attribution remains `UNKNOWN`. [Configuration and adapter details](docs/PHASE-1.md)
- **GitHub gate.** `github snapshot` reads the pull request, current-head checks, and formal reviews through the GitHub REST API. `github gate` validates Draft/mergeable state and mandatory human merge, emits a Review–Fix/CI action plan, and can materialize bounded agent tasks by stable action key. Bot approvals are excluded by default and can be enabled explicitly through `githubApproval.allowBotApprovals` or `--allow-bot-approvals`. `github serve-webhook` stores verified gates, materializes tasks only for mapped same-repository branches, and adds redacted failed-job classifications to fix prompts. Only same-head infrastructure or cancellation failures are automatically rerun, under an atomic per-head limit. Code/test, permission, unknown, and stale-head cases stay on explicit repair or human paths. [Phase 2 notes](docs/PHASE-2.md)
- **Local Dashboard.** `dashboard` serves a local workspace at `127.0.0.1:8788` with task state, events, attempts, Worker runs, checkpoints, handoff notes, budgets, repository mappings, and GitHub gate/CI history. Shared project and time filters combine with Lane filters for tasks and review-status filters for gates. Guarded `start`/`cancel`/`retry` actions require same-origin validation, an HttpOnly session, CSRF, exact confirmation, request idempotency, and audit. `start` spawns only a one-shot Worker child that rechecks lanes, quota, budgets, and due state. Worker logs require a matching task `start` audit event, return only the last 64 KiB, reject symlinks, and redact terminal controls and common secrets. It follows T3 Code-style desktop density while using a separate QuotaFlow information architecture, strict CSP, no external assets, and `textContent` rendering for untrusted text. [Phase 3 notes](docs/PHASE-3.md)

## Quick start

Run these PowerShell commands from the repository root with Bun and Git available. Supervised execution on Windows also requires Windows PowerShell (`powershell.exe`).

```powershell
bun run src/cli.ts --help
if (-not (Test-Path -LiteralPath quotaflow.config.json)) {
  Copy-Item quotaflow.config.example.json quotaflow.config.json
}
bun run src/cli.ts config validate
bun run src/cli.ts task add "Inspect the repository" --prompt "Summarize the project layout" --repo .
bun run src/cli.ts task list
```

macOS requires `/usr/bin/cc` from Xcode or Command Line Tools. Linux requires a C compiler and libc development headers, such as `gcc libc6-dev` on Debian or Ubuntu. macOS and Linux use `cp quotaflow.config.example.json quotaflow.config.json` to initialize the file. The remaining CLI commands are the same. The example Magpie endpoint is `http://127.0.0.1:3425/v1`.

Replace `TASK_ID` below with the ID returned by `task add`. The example uses placeholder quota windows, so running `worker once` with that configuration places the task in `waiting_quota`. Before running a live model, configure quota observations and the adapter for your approved execution lane. [Local configuration](docs/PHASE-1.md#本地运行)

```powershell
bun run src/cli.ts task show TASK_ID
bun run src/cli.ts task events TASK_ID
bun run src/cli.ts worker once --task-id TASK_ID
bun run src/cli.ts budget status
bun run src/cli.ts budget audit --limit 100
bun run src/cli.ts dashboard
```

On supported platforms, run `bun run poc/demo.ts` to see a simulated quota interruption and checkpoint handoff in a temporary Git repository. The demo uses fixture agents and requires no model credentials. macOS also requires the C compiler from Xcode or Command Line Tools, while Linux requires gcc and libc development headers. Use `bun test` for the test suite and `bun run build` to bundle the CLI into `dist/`. [PoC instructions](poc/README.md) · [Local execution and supervision](docs/PHASE-1.md#本地命令与平台监督)

## Documentation

| Document | Contents |
| --- | --- |
| [Roadmap](ROADMAP.md#english) · [Project plan](docs/PLAN.md) | Phase status, scope, and acceptance criteria |
| [Architecture](docs/ARCHITECTURE.md) · [Orchestration ADR](docs/adr/0001-orchestration-and-state.md) · [Model access ADR](docs/adr/0002-model-access.md) | Scheduling, recovery, and model access decisions |
| [Phase 0 report](docs/PHASE-0.md) · [Phase 1 notes](docs/PHASE-1.md) · [Phase 2 notes](docs/PHASE-2.md) · [Phase 3 notes](docs/PHASE-3.md) · [Verification evidence](docs/evidence/) | Test methods, results, and known limits |
| [Upstream research](docs/RESEARCH.md) · [Licensing review](docs/LICENSING-REVIEW.md) · [Requirements traceability](docs/TRACEABILITY.md) | Dependency evaluation and acceptance scenarios |
