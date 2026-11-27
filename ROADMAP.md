# QuotaFlow Roadmap / 路线图

[中文](#中文) · [English](#english) · [README](README.md) · [English README](README.en.md)

## 中文

**状态更新于 2026-11-27。** 各阶段按验收结果推进，详细范围和门槛见[建设计划](docs/PLAN.md)。

| 阶段 | 状态 | 交付与验收 |
| --- | --- | --- |
| Phase 0 · 可行性 | 有条件通过 | 已在临时仓库完成 Codex 写入、Git 检查点和 OpenCode 接续。原生 ChatGPT 执行通道、商业路由组和服务商账单归属仍待验证。 [验收记录](docs/PHASE-0-GATE-CLOSURE.md) |
| Phase 1 · 单机核心 | 进行中 | 已实现 CLI、SQLite 状态、额度和预算预留、Git 工作树、适配器、受监督重启恢复及取消升级。macOS 已验证本地命令停止和真实仓库检查点恢复。默认模型适配器继续使用 Windows 进程监督。 [当前实现与证据](docs/PHASE-1.md) |
| Phase 2 · GitHub 开发闭环 | 计划中 | 以最小权限将真实 Issue 推进至 Draft PR，加入独立审查、修复和 CI 分流，完善支持依赖、条件、并行和重试的版本化工作流。首个 `mcarplay` 试点需验证审查和 CI 证据对应当前提交、重复事件可安全处理，并由人工审核合并。 |
| Phase 3 · 界面与部署 | 计划中 | 交付 Dashboard 和多项目配置，核对 Dashboard 与 CLI 显示的任务状态，验证 Linux、Windows + WSL2 和 macOS 的支持范围，以及升级和备份恢复。 |
| Phase 4 · 基于运行证据的改进 | 计划中 | 用历史任务回放和影子评估验证调度、知识库、测试或审查规则提案，保留版本和回滚路径。 |
| Phase 5 · 长期运行 | 计划中 | 验证多仓库调度、预算公平性和连续运行，安排至少七天运行演练和一次备份恢复演练。低风险自动合并需单独授权。 |

### Phase 1 下一步

1. 验证 Linux 进程回收，确定 macOS 跨进程组和自定义 Codex App Server 的停止契约。
2. 完善预算租约过期审计、恢复后的冷却和重试策略。服务商账单归属继续记为 `UNKNOWN`，直到有可核对的账单证据。
3. 在 `mcarplay` 或同等规模的真实仓库验证端到端任务，补齐并发、额度等待和失败恢复回归，并完善工作树生命周期管理。 [Phase 1 里程碑](docs/PHASE-1.md#下一里程碑)

## English

**Status as of 2026-11-27.** Each phase advances when its acceptance criteria are met. See the [project plan](docs/PLAN.md) for the full scope and criteria.

| Phase | Status | Deliverables and acceptance |
| --- | --- | --- |
| Phase 0 · Feasibility | Passed with conditions | Demonstrated Codex writing changes, Git checkpointing, and OpenCode resuming in a temporary repository. Native ChatGPT execution, commercial routing groups, and provider invoice attribution still need verification. [Gate results](docs/PHASE-0-GATE-CLOSURE.md) |
| Phase 1 · Single-host core | In progress | The CLI, SQLite state, quota and budget reservations, Git worktrees, adapters, supervised restart recovery, and cancellation escalation are implemented. macOS verification covers local command shutdown and checkpoint recovery in a real repository. The default model adapters use Windows process supervision. [Implementation and evidence](docs/PHASE-1.md) |
| Phase 2 · GitHub development workflow | Planned | Take a real issue to a draft PR with least-privilege access, independent review, fixes, and CI triage. Complete versioned workflows with dependencies, conditions, parallel steps, and retries. The first `mcarplay` pilot must verify that review and CI evidence match the current commit, handle duplicate events safely, and keep merge approval with a human reviewer. |
| Phase 3 · Dashboard and deployment | Planned | Deliver a dashboard and multi-project configuration, verify that the dashboard and CLI show the same task state, and validate support for Linux, Windows with WSL2, and macOS, along with upgrades and backup recovery. |
| Phase 4 · Evidence-based improvements | Planned | Use historical task replay and shadow evaluation to assess proposed changes to scheduling, project knowledge, tests, or review rules. Keep version history and a rollback path. |
| Phase 5 · Sustained operation | Planned | Validate multi-repository scheduling, budget fairness, and continuous operation through a run of at least seven days and a backup recovery drill. Low-risk auto-merge requires separate approval. |

### Next steps for Phase 1

1. Verify Linux process cleanup and define stop verification across macOS process groups and for custom Codex App Server implementations.
2. Improve budget lease expiry auditing, recovery cooldowns, and retry policy. Keep provider invoice attribution at `UNKNOWN` until billing evidence is available.
3. Run an end-to-end task in `mcarplay` or a comparable real repository, add regression coverage for concurrency, quota waits, and failure recovery, and improve worktree lifecycle management. [Phase 1 milestones](docs/PHASE-1.md#下一里程碑)
