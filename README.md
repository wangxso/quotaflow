# QuotaFlow

QuotaFlow 是一个独立的额度感知 AI 软件研发平台。它在允许的账户、额度和预算范围内调度 Coding Agent，在 Agent 中断后从代码检查点续作，并把测试、审查和 CI 证据绑定到实际提交。mcarplay 是首个试点仓库，通过项目配置接入。

**当前状态 · 待审查。** 本地 Git 仓库已初始化，内容为项目方案和只读源码初筛。Phase 0 的可运行 PoC 在计划获批后启动。

## 审查入口

| 文档 | 审查内容 |
| --- | --- |
| [建设计划](docs/PLAN.md) | 建议批准的开工范围、Phase 0 试验、各阶段验收和范围取舍 |
| [架构建议](docs/ARCHITECTURE.md) | 额度调度、检查点、跨 Agent 续作、故障恢复和质量门禁 |
| [上游源码初筛](docs/RESEARCH.md) | 九个候选的源码与许可证证据、Archon 和 Magpie 验证项、mcarplay CI 基线 |
| [需求追踪与验收](docs/TRACEABILITY.md) | 原始需求章节映射和 14 个验收场景 |
| [ADR 0001](docs/adr/0001-orchestration-and-state.md) · [ADR 0002](docs/adr/0002-model-access.md) | 拟议的工作流底座、状态归属与模型接入决策 |

## 第一个可验收结果

Codex 在隔离工作区完成部分修改后收到额度耗尽信号，平台停止其进程树、保存可恢复的 Git 检查点，再由 OpenCode 读取已有改动并完成剩余任务。任务可在平台重启后恢复，每次调度、代码快照和测试结果均可追溯。故障注入和真实 Provider 接入分别留存运行证据。
