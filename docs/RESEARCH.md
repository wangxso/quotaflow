# 上游源码初筛

源码基线 · 2026-11-27。下表固定初筛时读取的公开源码提交与根许可证。发布版本、实测对照和复用结论见 [Phase 0 报告](PHASE-0.md)。

运行实验已验证 Archon 失败节点恢复、Magpie 隔离路由与本地回退、OpenCode 免费目录模型任务、真实 Codex Agent 写入、检查点恢复及跨 Agent 接续。候选固定树的许可证、NOTICE 与依赖锁文件面已初查；拟议方案不复制或分发上游代码／二进制。网关成本字段是 Magpie 价格计算，不能代表服务商账单；Codex 实际经 Magpie 路由到第三方模型，原生 ChatGPT 路径仍待验证。阶段结论见 [Phase 0 报告](PHASE-0.md)，许可证范围见[审查清单](LICENSING-REVIEW.md)。

## 候选基线

| 候选与快照 | 已阅读的实现及建议用途 | 源码与许可证 |
| --- | --- | --- |
| Archon `3a15fae9` | Provider 插件通过进程协议注册。Agent 节点解析 Provider 与模型，运行恢复可从 Store 读取已完成节点，流程事件有类型定义。优先验证为工作流底座。 | [插件加载](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/core/src/providers/load-provider-plugins.ts) · [节点调度](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/workflows/src/dag/nodes/agent/dispatch.ts) · [恢复](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/workflows/src/run-resume.ts) · [MIT](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/LICENSE) |
| Magpie `f8866483` | 网关实现额度查询的授权范围、用量查询和路由事件流，适合作为可选推理与遥测网关。 | [额度可见范围](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/quotas_scope.go) · [用量 API](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/usage_api.go) · [路由事件](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/route_events.go) · [MIT](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/LICENSE) |
| Symphony `be10a1b7` | Elixir 编排器轮询任务追踪器并向 Codex Worker 派发，规范描述了工作区与重启后的状态协调。作为调度与工作区恢复设计参考。 | [编排器](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/lib/symphony_elixir/orchestrator.ex) · [规范](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md) · [Apache-2.0](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/LICENSE) |
| Ralph Workflow `eb8a8574` | Python 源码有 Agent 注册机制和集成流程的 Git 状态恢复实现。可对照工作区回收设计，直接复用须先确认许可证适配性。 | [Agent 注册](https://github.com/Ralph-Workflow/Ralph-Workflow/blob/eb8a85742b8aaae6e970f3ca8f1755a3b2c9b011/ralph-workflow/ralph/agents/registry.py) · [Git 恢复状态](https://github.com/Ralph-Workflow/Ralph-Workflow/blob/eb8a85742b8aaae6e970f3ca8f1755a3b2c9b011/ralph-workflow/ralph/pipeline/_auto_integrate_recovery_git_state.py) · [AGPL-3.0](https://github.com/Ralph-Workflow/Ralph-Workflow/blob/eb8a85742b8aaae6e970f3ca8f1755a3b2c9b011/LICENSE) |
| Hats / Ralph Orchestrator `7d36cc76` | Rust 的 Hat 注册表按事件主题索引角色订阅，适合参考事件触发与角色编排。 | [Hat 注册表](https://github.com/mikeyobrien/ralph-orchestrator/blob/7d36cc76495e2145699d0191d35414f0e9d7a801/crates/ralph-core/src/hat_registry.rs) · [MIT](https://github.com/mikeyobrien/ralph-orchestrator/blob/7d36cc76495e2145699d0191d35414f0e9d7a801/LICENSE) |
| MetaSwarm `4bbb10ab` | 确定性规则校验多轮审查记录，可参考 Review–Fix 的终止条件和结果结构。 | [Review 规则](https://github.com/dsifry/metaswarm/blob/4bbb10abd301b9ec9d63371e296049cbc6043baa/lib/review-rule.js) · [MIT](https://github.com/dsifry/metaswarm/blob/4bbb10abd301b9ec9d63371e296049cbc6043baa/LICENSE) |
| OpenCode `3161ddcb` | Server 源码包含结构化事件订阅、类型筛选和队列溢出处理。作为 MVP 执行 Agent，优先验证已发布版本的会话接口、事件重连和任务取消。 | [API 入口](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/packages/server/src/api.ts) · [事件实现](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/packages/server/src/event-feed.ts) · [MIT](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/LICENSE) |
| AgentBridge `4cbffb14` | 契约定义统一流式执行结果，OpenCode 代码包含版本探测与服务进程管理。作为 Adapter 契约的对照，验证版本兼容与进程停止后再考虑依赖。 | [适配契约](https://github.com/rodolfonobrega/agentbridge/blob/4cbffb1470ee5d84ad94b6205e943102c464b12a/CONTRACT.md) · [OpenCode 适配器](https://github.com/rodolfonobrega/agentbridge/blob/4cbffb1470ee5d84ad94b6205e943102c464b12a/src/adapters/opencode.ts) · [MIT](https://github.com/rodolfonobrega/agentbridge/blob/4cbffb1470ee5d84ad94b6205e943102c464b12a/LICENSE) |
| Beads `708992f7` | `ready` 实现按依赖筛选可运行任务，并提供领取路径。作为依赖和任务记录的实现参考，MVP 任务状态留在编排器的持久化边界内。 | [领取路径](https://github.com/gastownhall/beads/blob/708992f78476c3dc5d11a44a3b273accd5e3c70c/cmd/bd/ready.go) · [MIT](https://github.com/gastownhall/beads/blob/708992f78476c3dc5d11a44a3b273accd5e3c70c/LICENSE) |

## Phase 0 运行对照

主对照采用 Archon 加外部适配与轻量独立核心。下表把已有静态证据与需要通过的运行用例对应起来。其余候选按拟复用能力进入对应对照项，源码与运行测试均记录版本。

| 选型核对项 | 已见证据或验证入口 | 判定方式 |
| --- | --- | --- |
| 1. 自定义 Agent Provider | Archon 有公开进程协议及插件加载实现。 | 安装实验插件并执行结构化会话，验证调度委托和取消。[协议源码](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/provider-contract/src/plugin/wire.ts) |
| 2. 运行期间动态切换 | Archon 节点记录 Provider 与模型，同一会话续用会检查二者。 | 同一任务内从 Codex 切至 OpenCode，旧进程退出后续作，保留中间差异并完成原节点目标。[会话判定](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/workflows/src/dag/nodes/agent/dispatch.ts#L249-L286) |
| 3. 持久化和异常恢复 | Archon 从 Store 读取节点输出并领取恢复执行权。 | 在节点、Git 检查点和状态写入的边界注入崩溃，重启后执行权唯一且已完成节点状态一致。[恢复源码](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/workflows/src/run-resume.ts#L49-L119) |
| 4. Git Worktree | Archon 实现工作区初始化及事件。 | 两任务并行隔离，旧进程的写权限可撤销，工作区改动可恢复。[Worktree 初始化](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/core/src/workflows/worktree-setup.ts) |
| 5. Issue、PR、CI | Archon 有 GitHub Webhook 路由。 | 利用本地测试事件和可授权测试仓库验证事件、审批、重复投递、Draft PR 和 CI 状态链路。[Webhook 源码](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/server/src/routes/webhooks.ts) |
| 6. 事件扩展 | Archon 有类型化工作流事件和 Web 事件订阅。 | 从事件断点重连，按运行及尝试 ID 对账，确认事件契约可供 CLI 和 Dashboard 使用。[事件定义](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/workflows/src/event-emitter.ts) |
| 7. 结构化结果 | Archon 提供读取 Provider 事件的 API，OpenCode 有事件源。 | 用同一输出契约记录结果、取消、限流和进程失败，解析实际模型及可用用量。[运行 API](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/server/src/routes/api.workflow-runs.ts#L75-L104) |
| 8. 无人值守 | Archon 恢复转换可记录额度恢复事件。 | 定时唤醒、重启和连续任务演练成功，等待项不阻塞其他任务，重试和日志量有界。[恢复转换](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/workflows/src/resume-transition.ts) |
| 9. 许可证和维护成本 | 已读取九个候选的根 `LICENSE`。 | 深入检查 NOTICE、三方许可证、构建、升级迁移、插件兼容及直接复用的义务。 |
| 10. Web 管理扩展 | Archon 提供 Dashboard 和工作流 API。 | 通过公开接口读取真实额度、尝试、检查点和审查记录，比较扩展成本与自建控制界面的成本。[API 参考](https://github.com/coleam00/Archon/blob/3a15fae9dc0db07fbeecba13c4f48aaadf3a6cdf/packages/docs-web/src/content/docs/reference/api.md) |

Codex App Server 的协议和账户限额类型作为原生接入研究入口。Phase 0 针对实际安装版本探测线程恢复、取消、账户读能力及多窗口的单位与授权范围。[App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [账户协议源码](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs)

## Magpie 集成核对项

- 源码包含 `/v1/magpie/quotas` 的额度范围控制、用量汇总与请求明细、并发观测和带游标的路由事件流。实际能看到的账户及字段取决于访问范围和上游供给。用量记录区分请求模型与实际服务模型，费用口径及可归属性在运行中核验。[额度范围](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/quotas_scope.go) · [网关](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/gateway.go#L458-L484) · [用量记录](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/usage/usage.go) · [事件](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/route_events.go)
- Routing Group 及请求回退由网关配置处理。Phase 0 验证组成员约束、请求与尝试的关联、实际模型和账户、远端与本机授权差异及服务模式。管理路由要求专门的管理权限，建议 QuotaFlow 常规运行使用推理与只读遥测权限。[路由与回退](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/docs/subsystems/gateway-routing.md) · [管理鉴权](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/gateway/admin.go)

## mcarplay 首个试点

公开仓库默认分支为 `main`。初筛快照为 `aea83de8`。CI 配置使用 Temurin JDK 21、Android SDK Platform 35、Build Tools 35.0.0、Python 3.12 和 Gradle Wrapper 8.10.2。试点执行前复核目标基线、分支规则与必需检查。[仓库快照](https://github.com/wangxso/mcarplay/commit/aea83de8fbcdfd3901a88051f78e4f1eabd60d9a) · [构建环境](https://github.com/wangxso/mcarplay/blob/aea83de8fbcdfd3901a88051f78e4f1eabd60d9a/.github/actions/setup-build/action.yml) · [Gradle Wrapper](https://github.com/wangxso/mcarplay/blob/aea83de8fbcdfd3901a88051f78e4f1eabd60d9a/gradle/wrapper/gradle-wrapper.properties)

Android CI 先发现并运行 `tools` 下的 Python 测试，再通过 Gradle 执行 `spotlessCheck`、`:app:testStandardDebugUnitTest`、`:app:lintStandardDebug`、`:app:assembleStandardDebug` 和带 `com.mcarplay.app.bridge.*` 筛选的 `:app:testRemoteDebugUnitTest`。纯文档改动有路径过滤，试点选择能触发正常 CI 的低风险 Issue。真实车机兼容性保留独立的硬件验证证据。[CI 配置](https://github.com/wangxso/mcarplay/blob/aea83de8fbcdfd3901a88051f78e4f1eabd60d9a/.github/workflows/android-ci.yml) · [仓库开发约定](https://github.com/wangxso/mcarplay/blob/aea83de8fbcdfd3901a88051f78e4f1eabd60d9a/AGENTS.md)
