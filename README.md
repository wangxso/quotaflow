# QuotaFlow

[English](README.en.md) · [路线图](ROADMAP.md#中文) · [贡献指南](AGENTS.md)

QuotaFlow 是一个额度感知的 AI 软件研发调度工具。它按账户额度、并发和预算安排 Codex 或 OpenCode 执行任务，将改动保存在独立的 Git 工作树和检查点中，供中断后恢复。

**当前状态（2026-11-27）**　Phase 0 技术门禁有条件通过，Phase 1 单机 CLI 正在开发。Phase 0 已在临时仓库验证 Codex 写入、保存检查点和 OpenCode 接续。Phase 1 已验证 Magpie 路由任务、OpenCode 请求级用量回写、Windows 受监督任务恢复和 Codex App Server 的受监督停止。首个 GitHub 试点计划使用 `mcarplay`，安排在 Phase 2。 [Phase 0 验收](docs/PHASE-0-GATE-CLOSURE.md) · [Phase 1 实现与验证](docs/PHASE-1.md)

## 当前功能

- **任务调度**　SQLite 持久化任务、尝试和事件。调度器以事务方式预留账户并发槽位、额度和已配置的预算。
- **执行与恢复**　CLI 支持提交、查看、取消和重试任务。Windows Job Object 监督覆盖默认 Codex App Server、OpenCode 和受监督命令。确认旧进程树退出后，才能保存检查点并恢复任务。缺少停止凭证的任务进入 `blocked`。
- **模型接入与用量**　提供 Codex App Server、OpenCode 和受监督命令适配器。Magpie 路由需要配置中的显式授权，网关估算用于预算租约，服务商账单归属仍为 `UNKNOWN`。这些执行路径目前仅支持 Windows。 [配置与适配器说明](docs/PHASE-1.md)

## 快速开始

在仓库根目录运行以下 PowerShell 命令。需要 Bun 和 Git，Windows 受监督执行还需要 Windows PowerShell（`powershell.exe`）。

```powershell
bun run src/cli.ts --help
if (-not (Test-Path -LiteralPath quotaflow.config.json)) {
  Copy-Item quotaflow.config.example.json quotaflow.config.json
}
bun run src/cli.ts config validate
bun run src/cli.ts task add "Inspect the repository" --prompt "Summarize the project layout" --repo .
bun run src/cli.ts task list
```

用 `task add` 返回的任务 ID 替换下方的 `TASK_ID`。示例配置的额度窗口是占位值，使用该配置调用 `worker once` 会进入 `waiting_quota`。运行真实模型前，为已授权的执行通道配置实际额度观测和适配器。 [运行配置](docs/PHASE-1.md#本地运行)

```powershell
bun run src/cli.ts task show TASK_ID
bun run src/cli.ts task events TASK_ID
bun run src/cli.ts budget status
```

在 Windows 上可运行 `bun run poc/demo.ts`，用合成执行器在临时 Git 仓库中体验额度中断和检查点接续，无需模型凭据。开发时使用 `bun test` 跑测试，使用 `bun run build` 将 CLI 打包到 `dist/`。 [PoC 复跑说明](poc/README.md)

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [路线图](ROADMAP.md#中文) · [建设计划](docs/PLAN.md) | 阶段状态、交付范围与验收门槛 |
| [架构](docs/ARCHITECTURE.md) · [编排 ADR](docs/adr/0001-orchestration-and-state.md) · [模型接入 ADR](docs/adr/0002-model-access.md) | 调度、恢复和模型接入决策 |
| [Phase 0 报告](docs/PHASE-0.md) · [Phase 1 说明](docs/PHASE-1.md) · [验收证据](docs/evidence/) | 验证方法、结果和已知限制 |
| [上游调研](docs/RESEARCH.md) · [许可证审查](docs/LICENSING-REVIEW.md) · [需求追踪](docs/TRACEABILITY.md) | 依赖评估与验收映射 |
