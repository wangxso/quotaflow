# Repository Guidelines

## Project Structure & Module Organization

- `src/cli.ts` is the QuotaFlow CLI entry point. `src/config.ts` and `src/domain.ts` define configuration and shared types. `src/db.ts` and `src/store.ts` manage SQLite state.
- Scheduling, execution, recovery, and Git worktrees live in `src/`, alongside the Codex and OpenCode adapters. Tests sit beside the code as `*.test.ts`.
- `poc/` contains Phase 0 experiments and fixture workers. Platform process guards live in `src/`. See `docs/PHASE-1.md` for current workflows, `docs/adr/` for design decisions, and `docs/evidence/` for recorded verification results.

## Build, Test, and Development Commands

Run commands from the repository root with Bun and Git available. The Windows process-guard scenarios also use PowerShell. macOS uses the C compiler from Xcode or Command Line Tools. Linux uses a C compiler and libc development headers.

- `bun run start --help` lists CLI commands.
- `bun run src/cli.ts config validate` validates local configuration. Copy `quotaflow.config.example.json` to `quotaflow.config.json` before configuring a local run.
- `bun run build` bundles the CLI for Bun into `dist/`.
- `bun test` runs the full suite. `bun test src/store.test.ts` runs a single test file.

## Coding Style & Naming Conventions

Match the TypeScript style in `src/`. Use two-space indentation, single quotes, semicolons, and `import type` for type-only imports. Use kebab-case filenames, camelCase functions and variables, and PascalCase types. The package defines build and test scripts without a dedicated lint or format script.

## Testing Guidelines

Use `test` and `expect` from `bun:test` with descriptive behavior names. Use fixture agents, temporary Git repositories, and isolated SQLite databases for regression checks. For scheduler or worker changes, exercise the affected quota, cancellation, or recovery behavior. Run the full suite before opening a pull request.

## Commit & Pull Request Guidelines

Follow recent history with short, imperative subjects such as `feat: support cooperative active task cancellation` or `docs: record Codex CLI write check`. In pull requests, explain the behavior change, link the relevant issue if available, and include test commands and results. For live provider checks, summarize the outcome and redact credentials from any evidence.
