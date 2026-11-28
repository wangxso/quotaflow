# QuotaFlow Roadmap / 路线图

[中文](#中文) · [English](#english) · [README](README.md) · [English README](README.en.md)

## 中文

**状态更新于 2026-11-28。** 各阶段按验收结果推进，详细范围和门槛见[建设计划](docs/PLAN.md)。

| 阶段 | 状态 | 交付与验收 |
| --- | --- | --- |
| Phase 0 · 可行性 | 有条件通过 | 已在临时仓库完成 Codex 写入、Git 检查点和 OpenCode 接续。原生 ChatGPT 执行通道、商业路由组和服务商账单归属仍待验证。 [验收记录](docs/PHASE-0-GATE-CLOSURE.md) |
| Phase 1 · 单机核心 | 进行中 | 已实现 CLI、SQLite v9 状态、预算到期审计、恢复后冷却、Git 工作树、三平台进程监督、重启恢复、取消升级及可选交接笔记。真实 `mcarplay` Issue 已通过 QuotaFlow 生成 Draft PR，剩余 Worktree 生命周期与 Provider 账单验证。 [当前实现与证据](docs/PHASE-1.md) |
| Phase 2 · GitHub 开发闭环 | 进行中 | PR #141 已完成 CI、mergeable、只读审查、最小权限 GitHub App 批准和仓库管理员人工合并，合并提交为 `23033142`。REST 快照、自动 Gate Webhook、双层幂等、仓库映射、分支白名单、动作任务物化、真实 CI 日志分类和 Actions read 已接入。下一步替换临时公网隧道并实现同 SHA 复跑。 |
| Phase 3 · 界面与部署 | 计划中 | GUI 与部署里程碑。交付 Dashboard 和多项目配置，核对 Dashboard 与 CLI 显示的任务状态，验证 Linux、Windows + WSL2 和 macOS 的支持范围，以及升级和备份恢复。 |
| Phase 4 · 基于运行证据的改进 | 计划中 | 用历史任务回放和影子评估验证调度、知识库、测试或审查规则提案，保留版本和回滚路径。 |
| Phase 5 · 长期运行 | 计划中 | 验证多仓库调度、预算公平性和连续运行，安排至少七天运行演练和一次备份恢复演练。低风险自动合并需单独授权。 |

### Phase 1 下一步

1. 自动化 Worktree 生命周期、清理和备份恢复。
2. 接入可核对的 Provider 账单证据。
3. 完成 Phase 2 独立审查、CI 失败分流与重复事件门禁。 [Phase 1 里程碑](docs/PHASE-1.md#下一里程碑)

## English

**Status as of 2026-11-28.** Each phase advances when its acceptance criteria are met. See the [project plan](docs/PLAN.md) for the full scope and criteria.

| Phase | Status | Deliverables and acceptance |
| --- | --- | --- |
| Phase 0 · Feasibility | Passed with conditions | Demonstrated Codex writing changes, Git checkpointing, and OpenCode resuming in a temporary repository. Native ChatGPT execution, commercial routing groups, and provider invoice attribution still need verification. [Gate results](docs/PHASE-0-GATE-CLOSURE.md) |
| Phase 1 · Single-host core | In progress | The CLI, SQLite v9 state, budget expiry audits, recovery cooldowns, Git worktrees, three-platform process supervision, restart recovery, cancellation escalation, and optional handoff notes are implemented. The default macOS adapters have run live, while Linux has passed subreaper cleanup and Codex App Server smoke tests. [Implementation and evidence](docs/PHASE-1.md) |
| Phase 2 · GitHub development workflow | In progress | PR #141 passed current-head CI, mergeability, read-only review, least-privilege GitHub App approval, and repository-owner human merge at merge commit `23033142`. REST snapshots, gate-processing webhooks, two-level idempotency, repository mappings, branch allowlists, action-task materialization, real CI log classification, and Actions read access are implemented. Next work replaces the temporary tunnel and adds same-SHA reruns. |
| Phase 3 · Dashboard and deployment | Planned | GUI and deployment milestone. Deliver a dashboard and multi-project configuration, verify that the dashboard and CLI show the same task state, and validate support for Linux, Windows with WSL2, and macOS, along with upgrades and backup recovery. |
| Phase 4 · Evidence-based improvements | Planned | Use historical task replay and shadow evaluation to assess proposed changes to scheduling, project knowledge, tests, or review rules. Keep version history and a rollback path. |
| Phase 5 · Sustained operation | Planned | Validate multi-repository scheduling, budget fairness, and continuous operation through a run of at least seven days and a backup recovery drill. Low-risk auto-merge requires separate approval. |

### Next steps for Phase 1

1. Automate worktree lifecycle, cleanup, and backup recovery.
2. Add verifiable provider billing evidence.
3. Complete Phase 2 independent review, CI triage, and duplicate-event gates. [Phase 1 milestones](docs/PHASE-1.md#下一里程碑)
