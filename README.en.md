# QuotaFlow

[简体中文](README.md) · [Roadmap](ROADMAP.md#english) · [Contributor guide](AGENTS.md)

QuotaFlow schedules AI software development tasks using account quotas, concurrency limits, and budgets. It runs Codex or OpenCode in dedicated Git worktrees and saves checkpoints so interrupted work can resume.

**Status as of 2026-11-27.** Phase 0 passed its technical gate with conditions and demonstrated Codex writing changes, Git checkpointing, and OpenCode resuming in a temporary repository. The Phase 1 single-host CLI is in development. Windows verification covers Magpie-routed tasks, request-level OpenCode usage reconciliation, and supervised recovery. macOS verification covers local command cancellation, child process cleanup, Git checkpoint recovery, and a live Codex-to-OpenCode handoff through Magpie after the native quota was exhausted. The default macOS model adapters still need cross-process-group supervision. The first GitHub pilot is planned for Phase 2 with `mcarplay`. [Phase 0 gate results](docs/PHASE-0-GATE-CLOSURE.md) · [Phase 1 implementation and verification](docs/PHASE-1.md)

## Current capabilities

- **Scheduling.** SQLite stores tasks, attempts, and events. The scheduler reserves account concurrency slots, quota, and any configured budget in one transaction.
- **Execution and recovery.** The CLI can submit, inspect, cancel, and retry tasks. Windows uses Job Objects. macOS supports supervised local `command` lanes whose commands and children stay in the original process group. Checkpointing and recovery require a stop receipt. A launched supervised attempt with a missing receipt stays `blocked` and retains write ownership. `--handoff` can pass a checkpoint-bound note to the next agent after an interruption.
- **Adapters and usage.** The default Codex App Server and OpenCode adapters require Windows process supervision. Magpie routing requires explicit configuration approval. Gateway estimates back budget leases, and provider invoice attribution remains `UNKNOWN`. [Configuration and adapter details](docs/PHASE-1.md)

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

Replace `TASK_ID` below with the ID returned by `task add`. The example uses placeholder quota windows, so running `worker once` with that configuration places the task in `waiting_quota`. Before running a live model, configure quota observations and the adapter for your approved execution lane. [Local configuration](docs/PHASE-1.md#本地运行)

```powershell
bun run src/cli.ts task show TASK_ID
bun run src/cli.ts task events TASK_ID
bun run src/cli.ts budget status
```

On Windows or macOS, run `bun run poc/demo.ts` to see a simulated quota interruption and checkpoint handoff in a temporary Git repository. The demo uses fixture agents and requires no model credentials. macOS also requires the C compiler from Xcode or Command Line Tools. Use `bun test` for the test suite and `bun run build` to bundle the CLI into `dist/`. [PoC instructions](poc/README.md) · [macOS verification](docs/PHASE-1.md#macos-本地命令验证)

## Documentation

| Document | Contents |
| --- | --- |
| [Roadmap](ROADMAP.md#english) · [Project plan](docs/PLAN.md) | Phase status, scope, and acceptance criteria |
| [Architecture](docs/ARCHITECTURE.md) · [Orchestration ADR](docs/adr/0001-orchestration-and-state.md) · [Model access ADR](docs/adr/0002-model-access.md) | Scheduling, recovery, and model access decisions |
| [Phase 0 report](docs/PHASE-0.md) · [Phase 1 notes](docs/PHASE-1.md) · [Verification evidence](docs/evidence/) | Test methods, results, and known limits |
| [Upstream research](docs/RESEARCH.md) · [Licensing review](docs/LICENSING-REVIEW.md) · [Requirements traceability](docs/TRACEABILITY.md) | Dependency evaluation and acceptance scenarios |
