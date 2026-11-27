# QuotaFlow Phase 0 验证报告

**日期** 2026-11-27

**结论** PoC 与部分可行性验证已交付；阶段门禁 **未通过**，Phase 1 尚未开始。

## 结论摘要

- Windows 本机 PoC 的 8 项确定性故障恢复测试最终全部通过（56 项断言）。它覆盖额度中断、进程树停止、Git 检查点、控制器崩溃恢复、写入租约唯一性和并发额度槽位。
- OpenCode 通过 Magpie 中标记为免费额度的 `hy4-flash-free` 完成了隔离工作区文件交接。JSON 事件记录 2 次工具调用、退出码 0、无错误；结果文件精确匹配预期，SHA-256 为 `E5343BC9E29216AB67D3C8FFF815D2560199505DD2C065887D0D7E69C9DD4A36`。
- 独立 Magpie 实例通过实际本地 Qwen 推理验证 Routing Group、首个上游 503 后回退、路由事件流及用量观测；Archon 也完成了失败节点保存与恢复试验。
- **真实 Codex Agent 写入未通过**：结构化只读回合成功返回 `41`，控制器随后写入并能恢复会话；Agent 自身写文件的试验没有形成合格文件检查点，其中一次未在 150 秒内完成。该尝试没有重跑。
- 因真实 Codex 写入、商业账户的实际计费归属、最小权限字段范围及完整第三方许可证审计尚无充分证据，不能宣告跨 Agent 真实恢复通过，也不放行 Phase 1。

## 环境与工具版本

测试运行于 Windows 11 家庭版（Build 26200）、PowerShell 7.6.9、Git for Windows 2.49.0、Bun 1.4.5。未使用 Docker 或 WSL 部署 PoC。

| 工具 | 实测版本 | SHA-256（下载二进制） |
| --- | --- | --- |
| Archon CLI | 0.16.0，内置 Git commit `ecb76c34` | `96078E18462325995F984DC8E2B0511D9CE77CDD207AAA07EF6732EFA39FD643` |
| OpenCode | 1.19.6 | `520970E4FB362A1BE91B52B79960AA5FB24031CEB33F4C47E38A751A6B8A24B9` |
| Magpie CLI | 0.1.4931 | `FED3B934AD638527B0FA5E3A022260FEB0852F6CE1AA65739600E9C93B867D62` |
| Bun | 1.4.5 | `E06AD0864463C68892AE71A2A64AF7EAE1585CAC5DD9B80BC042F45605587CB1` |
| Codex CLI / App Server | 0.172.0 | 系统安装版本 |

本机正在运行的 Magpie 服务为 0.1.4783，与下载用于隔离实验的 CLI 0.1.4931 不同。下载二进制已按发行版 SHA-256 校验。PoC 源码与复跑入口见 [poc/README.md](../poc/README.md)。

## Phase 0 工作项结果

| 工作项 | 结果 | 证据与限制 |
| --- | --- | --- |
| 0.1 上游与许可证 | 部分完成 | 九个候选的源码快照及根许可证初筛已记录；Archon、OpenCode、Magpie 等可运行版本已固定。尚未完成所有候选的 NOTICE、传递依赖许可证、复用义务及维护成本审计。详见[源码初筛](RESEARCH.md)。 |
| 0.2 Agent 接入 | 部分完成 | Codex App Server `account/read` 和 `rateLimits/read` 可读到 ChatGPT Plus 账户、300 分钟与 10080 分钟窗口及无额外 credits；结构化只读回合返回 41，App Server 重启后同一线程可恢复。控制器写入 `app.txt` 并建立检查点不等于 Agent 写入成功。Agent 写入试验未通过。OpenCode 免费目录模型的独立小任务成功，但此结果没有商业用量归属证据。 |
| 0.3 Magpie | 部分完成 | 本机只读接口中模型目录、额度、历史、账户、用量、请求、并发和路由事件端点可访问；管理端点返回 403，现有目录没有 Routing Group。另一个隔离实例验证了 `group/phase0`、503 回退、本地 Qwen 实际模型、46 tokens 用量和 SSE 路由流。商业 Provider 账单归属、各凭据权限差异与真实账户的跨请求核销仍待验证。 |
| 0.4 故障恢复 | 确定性 PoC 通过；真实跨 Agent 验收未通过 | 最新复跑 8 项通过、0 项失败。测试覆盖已暂存／未暂存／删除／未跟踪文件、旧进程停止、崩溃前后 Git 引用幂等、并发账户槽位、额度等待和缺少停止凭证时阻止接管。较早一轮曾有 1 项恢复测试失败，修复后复跑通过。真实 Codex 写入触发 OpenCode 接管的完整链路未通过。 |
| 0.5 Archon 对照 | 部分完成 | Archon 0.16.0 保存失败状态后在不同 Worktree 恢复并完成，跳过已完成节点，保留补丁；`resume --json` 是预览，需显式执行恢复。该试验没有证明公开接口可交出 QuotaFlow 任务级额度租约、强制回收外部 Agent 进程或使用 QuotaFlow Git 检查点。 |

### 实际运行记录

- **确定性恢复**：`bun test poc/phase0.test.ts`，最终 8 pass、0 fail、56 assertions。首次完整复跑有 7 pass、1 fail（未生成进程停止凭证）；随后修正恢复路径后完整复跑通过。该代码是 Windows Job Object/PowerShell 监督器上的测试适配器，不是生产级沙箱。
- **OpenCode**：请求模型标识 `magpie/opencode-go/hy4-flash-free`；JSON 事件为 `step_start:3`、`tool_use:2`、`step_finish:3`、`text:1`，退出码 0，错误 0。结果内容为 `QuotaFlow Phase 0 handoff completed.` 加换行。首次检查器漏写句号，导致假阴性；修正断言后复跑通过。
- **Magpie 隔离实例**：路由组首选上游返回 503，备用本地 Qwen 回答 42；观察到实际模型、用量 46、路由 SSE。OpenCode 从 Codex 测试 Worktree 的检查点读到 `app.txt=41` 并输出 41。Codex 文件由控制器写入，因此这只证明跨运行器读取数据，不证明 Codex Agent 写入。
- **Codex**：结构化只读回合获得 `41`，token usage 事件存在，服务重启后线程恢复成功；单独的 Agent 写入检查未满足文件断言，另一次 150 秒尝试没有 `turn/completed` 和检查点。没有继续消耗订阅额度重试。
- **本机 Magpie 只读探测**：目录、额度、额度历史、账户、用量、请求、并发、路由快照及 SSE 端点返回成功；管理端点 403。探测未发起推理请求。
- **Archon**：`failed → completed`，补丁保留，节点续跑，最终结果 42。

运行结果摘要和测试源代码保存在本仓库；本机凭据、会话 ID、账户标识和请求正文未写入项目文件。

## 选型结论

1. **工作流与状态**：Phase 1 原型建议采用轻量独立核心（TypeScript、Bun、SQLite、Git 检查点），由控制器拥有额度与工作区写入租约；本结论仍为暂定，须在真实 Codex 写入与恢复门禁通过后定版。Archon 保留为工作流及 GitHub 集成参考，不作为当前主运行器。
2. **模型与遥测**：Magpie 作为可选网关保留；Codex 与 OpenCode 原生接入也保留。额度来源、模型身份、成本或账户无法归属时必须标成 `UNKNOWN`，不得把“免费”目录标签当成实际零成本证明。
3. **平台边界**：当前进程回收 PoC 只在 Windows 验证。Linux、macOS、WSL2、生产仓库文件权限、网络隔离、GitHub 写操作幂等性均未验证。

## Phase 1 开工门禁

**判定：未通过。** 继续 Phase 1 前需要补齐以下证据并复核 ADR：

1. 在授权的原生 Codex 通道完成一次受限的 Agent 文件写入，核对事件、退出、工作区差异与 Git 检查点；本轮未重试该调用。
2. 用该 Agent 产出的实际检查点让 OpenCode 接续剩余任务，确认旧写入者已退出、改动无丢失、测试通过。
3. 完成上游 NOTICE／传递依赖许可证和复用义务检查，并针对实际采用的 Magpie 权限核对模型、额度、用量与成本的可见性及计费归属。
4. 将本报告中的限制和状态同步到计划及 ADR，由项目负责人审查后再启动 Phase 1。

在上述门禁前，不把本次测试适配器或本地模拟上游描述为生产可用平台，也不运行 mcarplay 真实 Issue。
