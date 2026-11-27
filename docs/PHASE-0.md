# QuotaFlow Phase 0 验证报告

**日期** 2026-11-27

**结论** PoC 与部分可行性验证已交付；阶段门禁 **未通过**，Phase 1 尚未开始。

## 结论摘要

- Windows 本机 PoC 的 8 项确定性故障恢复测试最终全部通过（56 项断言）。它覆盖额度中断、进程树停止、Git 检查点、控制器崩溃恢复、写入租约唯一性和并发额度槽位。
- OpenCode 通过 Magpie 中标记为免费额度的 `hy4-flash-free` 完成了隔离工作区文件交接。JSON 事件记录 2 次工具调用、退出码 0、无错误；结果文件精确匹配预期，SHA-256 为 `E5343BC9E29216AB67D3C8FFF815D2560199505DD2C065887D0D7E69C9DD4A36`。
- 独立 Magpie 实例通过实际本地 Qwen 推理验证 Routing Group、首个上游 503 后回退、路由事件流及用量观测；Archon 也完成了失败节点保存与恢复试验。
- **本机 Codex CLI 文件写入通过；Codex App Server 工作区运行时仍未打通**：结构化只读回合成功返回 `41`，控制器随后写入并能恢复会话。用户授权的一次受限 App Server 写入重试中，回合完成且线程可恢复，但两次命令执行均因 `workspace runtime service unavailable` 失败，PowerShell 未能启动，工作树无变更、无检查点。之后单独通过 Codex CLI 0.172.0 在 `workspace-write` 沙箱中创建验证文件，读回内容为 `OK` 并删除；这证明本机 CLI 可以写工作区文件，不证明 App Server 执行后端或 Git 检查点接续可用。
- 本机 Magpie 请求记录将 OpenCode 的请求模型、实际服务模型和账户引用关联起来；成功请求的 Magpie 价格计算为 0。Magpie 的价格记录不是服务商发票，实际订阅账单仍是 `UNKNOWN`。App Server 写入与跨 Agent 检查点接续仍未验证，且商用路由组与账单未验证，故不放行 Phase 1。

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
| 0.1 上游与许可证 | 部分完成；当前不复用上游制品 | 九个候选固定树的根／嵌套许可证、NOTICE 和依赖锁文件面已清点；详见[许可证审查](LICENSING-REVIEW.md)。当前建议不复制代码或分发上游二进制，所以全量传递依赖扫描按具体发布制品执行。候选升级与维护成本尚未量化；模型权重来源也未进入交付审计。 |
| 0.2 Agent 接入 | 部分完成 | Codex App Server `account/read` 和 `rateLimits/read` 可读到 ChatGPT Plus 账户、300 分钟与 10080 分钟窗口及无额外 credits；结构化只读回合返回 41，服务重启后线程可恢复。App Server 受限写入仍因工作区运行时服务不可用失败，未生成文件或检查点。另一次本机 Codex CLI `workspace-write` 文件写入验证成功，随后删除验证文件；它没有验证 App Server 执行后端或 Git 检查点。OpenCode 隔离小任务成功并有 Magpie 请求级用量记录。 |
| 0.3 Magpie | 部分完成 | 本机目录、额度、历史、账户、用量、请求、并发和路由事件端点可访问；管理端点返回 403，现有目录没有 Routing Group。OpenCode 请求记录显示请求模型 `opencode-go/hy4-flash-free`、服务模型 `hy4-flash-free`、可关联的本机账户引用；3 个成功响应标记为 priced，Magpie cost 为 0，另有 1 个取消请求未计价。该 cost 是 Magpie 价格计算，不能证明服务商实收为 0。隔离实例另验证了 `group/phase0`、503 回退、本地 Qwen 的 46 tokens 用量和 SSE；尚未用商用 Provider 走 Routing Group。 |
| 0.4 故障恢复 | 确定性 PoC 通过；真实跨 Agent 验收未通过 | 最新复跑 8 项通过、0 项失败。测试覆盖已暂存／未暂存／删除／未跟踪文件、旧进程停止、崩溃前后 Git 引用幂等、并发账户槽位、额度等待和缺少停止凭证时阻止接管。较早一轮曾有 1 项恢复测试失败，修复后复跑通过。Codex CLI 单文件写入虽已验证，但 Codex Agent 写入触发 OpenCode 接管并使用检查点的完整链路未通过。 |
| 0.5 Archon 对照 | 部分完成 | Archon 0.16.0 保存失败状态后在不同 Worktree 恢复并完成，跳过已完成节点，保留补丁；`resume --json` 是预览，需显式执行恢复。该试验没有证明公开接口可交出 QuotaFlow 任务级额度租约、强制回收外部 Agent 进程或使用 QuotaFlow Git 检查点。 |

### 实际运行记录

- **确定性恢复**：`bun test poc/phase0.test.ts`，最终 8 pass、0 fail、56 assertions。首次完整复跑有 7 pass、1 fail（未生成进程停止凭证）；随后修正恢复路径后完整复跑通过。该代码是 Windows Job Object/PowerShell 监督器上的测试适配器，不是生产级沙箱。
- **OpenCode**：请求模型标识 `magpie/opencode-go/hy4-flash-free`；JSON 事件为 `step_start:3`、`tool_use:2`、`step_finish:3`、`text:1`，退出码 0，错误 0。结果内容为 `QuotaFlow Phase 0 handoff completed.` 加换行。首次检查器漏写句号，导致假阴性；修正断言后复跑通过。
- **OpenCode 用量归属**：本机 Magpie 在 12:51（Asia/Shanghai）记录该测试时段 3 个 HTTP 200 响应，`req=opencode-go/hy4-flash-free`、`served=hy4-flash-free`、`cost=0`、`priced=true`，并有可匹配本机账户目录的账户引用；另有 1 个 HTTP 499 取消记录，`priced=false`。请求记录不含服务商发票金额。为避免泄露，账户 ID、provider key 和 route ID 未写入报告。
- **Magpie 隔离实例**：路由组首选上游返回 503，备用本地 Qwen 回答 42；观察到实际模型、用量 46、路由 SSE。OpenCode 从 Codex 测试 Worktree 的检查点读到 `app.txt=41` 并输出 41。Codex 文件由控制器写入，因此这只证明跨运行器读取数据，不证明 Codex Agent 写入。
- **Codex**：App Server 额度读取与结构化只读回合成功；该回合返回 `41`，控制器写入并建立检查点，App Server 重启后线程恢复成功。随后唯一获准的写入重试发起 1 个原生订阅回合，收到 `turn/completed` 与 token usage，但两次 shell 命令执行失败，Agent 明确报告 `workspace runtime service unavailable`，因此 `app.txt` 未改、Git 工作树干净且无检查点。先前一次 150 秒试验也未完成。另一次独立 Codex CLI 0.172.0 运行从 `xia` 目录以 `--skip-git-repo-check` 启动，banner 显示 `workspace-write`；Agent 创建 `outputs/QuotaFlow/CODEX-WRITE-CHECK.tmp`，验证其长度为 2 字节，用户读回 `OK` 后删除。该次 CLI 成功证明本机 CLI 文件写入可用，但未产生 Git 检查点或调用 App Server 执行后端。
- **本机 Magpie 只读探测**：目录、额度、额度历史、账户、用量、请求、并发、路由快照及 SSE 端点返回成功；管理端点 403。探测未发起推理请求。
- **Archon**：`failed → completed`，补丁保留，节点续跑，最终结果 42。

运行结果摘要和测试源代码保存在本仓库；本机凭据、会话 ID、账户标识和请求正文未写入项目文件。上游许可证和依赖面清单见[许可证审查](LICENSING-REVIEW.md)。

## 选型结论

1. **工作流与状态**：Phase 1 原型建议采用轻量独立核心（TypeScript、Bun、SQLite、Git 检查点），由控制器拥有额度与工作区写入租约；本结论仍为暂定，须在真实 Codex 写入与恢复门禁通过后定版。Archon 保留为工作流及 GitHub 集成参考，不作为当前主运行器。
2. **模型与遥测**：Magpie 作为可选网关保留；Codex 与 OpenCode 原生接入也保留。Magpie 能为测试请求记录请求模型、服务模型、账户引用及其自身价格计算；外部账单金额必须与其分开，无法验证时记为 `UNKNOWN`。不得把“免费”目录标签或 Magpie 的零价格记录当成服务商零账单证明。
3. **平台边界**：当前进程回收 PoC 只在 Windows 验证。Linux、macOS、WSL2、生产仓库文件权限、网络隔离、GitHub 写操作幂等性均未验证。

## Phase 1 开工门禁

**判定：未通过。** 继续 Phase 1 前需要补齐以下证据并复核 ADR：

1. Codex App Server 可用的本地工作区运行时仍须能正常启动 shell。独立 CLI 的 `workspace-write` 写入已成功，但不满足 App Server 运行时门禁。
2. 在该运行时下取得 Codex Agent 实际生成的文件检查点，再由 OpenCode 接续剩余项，确认旧写入者退出、改动保留且测试通过。
3. 若 Phase 1 要求商用路由组，需获得可配置的测试 Provider 权限，并将 Magpie 价格估算与服务商账单分别核对；当前隔离路由只使用本地 Qwen。
4. 许可证范围建议按[审查清单](LICENSING-REVIEW.md)执行：保持工具外部安装、不打包。若要打包，再对具体发布制品完成 SBOM 与 NOTICE 复核。
5. 将本报告中的限制和状态同步到计划及 ADR，由项目负责人审查后再启动 Phase 1。

在上述门禁前，不把本次测试适配器或本地模拟上游描述为生产可用平台，也不运行 mcarplay 真实 Issue。
