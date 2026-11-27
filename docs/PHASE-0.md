# QuotaFlow Phase 0 验证报告

**日期** 2026-11-27

**结论** PoC 与关键可行性验证已交付；阶段技术门禁 **有条件通过**。项目负责人已允许 Phase 1 使用 Magpie 路由模型，Phase 1 核心底座已启动。

**2026-11-27 门禁收口更新** App Server 零推理 shell 预检已连续通过，真实 Codex Agent 写入、检查点恢复及 OpenCode 跨 Agent 接续也已完成。Codex 实际路由为 Magpie 的 `opencode-go/deepseek-v4.1-flash`，不是原生 ChatGPT；服务商账单仍为 `UNKNOWN`。详见[门禁收口记录](PHASE-0-GATE-CLOSURE.md)。

## 结论摘要

- Windows 本机 PoC 的 8 项确定性故障恢复测试最终全部通过（56 项断言）。它覆盖额度中断、进程树停止、Git 检查点、控制器崩溃恢复、写入租约唯一性和并发额度槽位。
- OpenCode 通过 Magpie 中标记为免费额度的 `hy4-flash-free` 完成了隔离工作区文件交接。JSON 事件记录 2 次工具调用、退出码 0、无错误；结果文件精确匹配预期，SHA-256 为 `E5343BC9E29216AB67D3C8FFF815D2560199505DD2C065887D0D7E69C9DD4A36`。
- 独立 Magpie 实例通过实际本地 Qwen 推理验证 Routing Group、首个上游 503 后回退、路由事件流及用量观测；Archon 也完成了失败节点保存与恢复试验。
- **Codex App Server 工作区运行时已完成收口**：零推理 shell 预检连续通过；随后真实 Agent 回合完成 `app.txt=41` 写入，生成检查点并在 App Server 重启后恢复线程。该回合实际走 Magpie 的 `opencode-go/deepseek-v4.1-flash`，不是原生 ChatGPT。
- OpenCode 在同一 Worktree 读取 `41`，写入 `42\n` 并完成复核；旧写入进程为 0，最终检查点已验证。确定性恢复 8/8 与 App Server 运行时测试 2/2 合计 10/10 通过。
- 本机 Magpie 请求记录将 Codex 和 OpenCode 的请求模型、实际服务模型和账户引用关联起来。Magpie 的成本字段是价格估算，不是服务商发票；实际订阅或 API 账单仍为 `UNKNOWN`。商用路由组仍未验证。

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
| 0.2 Agent 接入 | 通过（有条件） | Codex App Server 的零推理 `command/exec` 预检连续通过，真实 Agent 回合完成 `app.txt=41` 写入并生成检查点，服务重启后线程恢复。该回合实际模型为 `opencode-go/deepseek-v4.1-flash`，经 Magpie 路由；原生 ChatGPT 模型路径尚未验证。OpenCode 1.19.6 在隔离配置下用免费模型完成读取和写入。 |
| 0.3 Magpie | 部分完成 | 本机目录、额度、历史、账户、用量、请求、并发和路由事件端点可访问；管理端点返回 403，现有目录没有 Routing Group。OpenCode 请求记录显示请求模型 `opencode-go/hy4-flash-free`、服务模型 `hy4-flash-free`、可关联的本机账户引用；3 个成功响应标记为 priced，Magpie cost 为 0，另有 1 个取消请求未计价。该 cost 是 Magpie 价格计算，不能证明服务商实收为 0。隔离实例另验证了 `group/phase0`、503 回退、本地 Qwen 的 46 tokens 用量和 SSE；尚未用商用 Provider 走 Routing Group。 |
| 0.4 故障恢复 | 通过（有条件） | 确定性复跑 8 项通过、0 项失败。真实链路由 Codex Agent 写入 `app.txt=41`、生成检查点、确认旧写入进程为 0，再由 OpenCode 从同一 Worktree 写入 `answer.txt=42\n`；工作区仅保留预期改动，最终检查点已验证。复现证据见[门禁收口记录](PHASE-0-GATE-CLOSURE.md)。 |
| 0.5 Archon 对照 | 部分完成 | Archon 0.16.0 保存失败状态后在不同 Worktree 恢复并完成，跳过已完成节点，保留补丁；`resume --json` 是预览，需显式执行恢复。该试验没有证明公开接口可交出 QuotaFlow 任务级额度租约、强制回收外部 Agent 进程或使用 QuotaFlow Git 检查点。 |

### 实际运行记录

- **确定性恢复**：`bun test poc/phase0.test.ts`，最终 8 pass、0 fail、56 assertions。首次完整复跑有 7 pass、1 fail（未生成进程停止凭证）；随后修正恢复路径后完整复跑通过。该代码是 Windows Job Object/PowerShell 监督器上的测试适配器，不是生产级沙箱。
- **OpenCode**：请求模型标识 `magpie/opencode-go/hy4-flash-free`；JSON 事件为 `step_start:3`、`tool_use:2`、`step_finish:3`、`text:1`，退出码 0，错误 0。结果内容为 `QuotaFlow Phase 0 handoff completed.` 加换行。首次检查器漏写句号，导致假阴性；修正断言后复跑通过。
- **OpenCode 用量归属**：本机 Magpie 在 12:51（Asia/Shanghai）记录该测试时段 3 个 HTTP 200 响应，`req=opencode-go/hy4-flash-free`、`served=hy4-flash-free`、`cost=0`、`priced=true`，并有可匹配本机账户目录的账户引用；另有 1 个 HTTP 499 取消记录，`priced=false`。请求记录不含服务商发票金额。为避免泄露，账户 ID、provider key 和 route ID 未写入报告。
- **Magpie 隔离实例**：路由组首选上游返回 503，备用本地 Qwen 回答 42；观察到实际模型、用量 46、路由 SSE。OpenCode 从 Codex 测试 Worktree 的检查点读到 `app.txt=41` 并输出 41。Codex 文件由控制器写入，因此这只证明跨运行器读取数据，不证明 Codex Agent 写入。
- **Codex（早期尝试，已由后续记录取代）**：App Server 额度读取与结构化只读回合成功；该回合返回 `41`，控制器写入并建立检查点，App Server 重启后线程恢复成功。随后一次写入重试收到 `turn/completed` 与 token usage，但两次 shell 命令执行失败，Agent 明确报告 `workspace runtime service unavailable`，因此 `app.txt` 未改、Git 工作树干净且无检查点。先前一次 150 秒试验也未完成。另一次独立 Codex CLI 0.172.0 运行从 `xia` 目录以 `--skip-git-repo-check` 启动，banner 显示 `workspace-write`；Agent 创建 `outputs/QuotaFlow/CODEX-WRITE-CHECK.tmp`，验证其长度为 2 字节，用户读回 `OK` 后删除。该次 CLI 成功证明本机 CLI 文件写入可用，但未产生 Git 检查点或调用 App Server 执行后端。以上均为运行时修复前的记录，不作为当前门禁结论。
- **Codex App Server 真实写入（最新通过记录）**：`agent-write` 回合收到 `turn/completed` 和 token usage，`app.txt` 由 Agent 写为 `41`，仅该文件改变；检查点 `4dd50cc7...` 生成，App Server 重启后线程恢复。实际请求经 Magpie 路由到 `opencode-go/deepseek-v4.1-flash`，不能记为原生订阅账单。
- **OpenCode 接续**：使用 `magpie/opencode-go/hy4-flash-free`，工具序列 `read → write → bash`，读取 `41`，写入 `answer.txt` 的字节为 `52,50,10`，退出码 0、成本 0。交接后最终检查点为 `ab273a27...`。
- **App Server 零推理预检**：stdio 连续 10/10 通过；启动 managed daemon 后 `windowsSandbox=ready`，再连续 5/5 通过。managed daemon 的 `app-server proxy` 初始化超时，未作为本轮主证据。另用不存在的 `QUOTAFLOW_PREFLIGHT_SHELL` 运行 `native-codex.ts`，预检返回 `-32603`，`inferenceTurnsRequested` 保持 0，未创建线程或发起回合。
- **本机 Magpie 只读探测**：目录、额度、额度历史、账户、用量、请求、并发、路由快照及 SSE 端点返回成功；管理端点 403。探测未发起推理请求。
- **Archon**：`failed → completed`，补丁保留，节点续跑，最终结果 42。

运行结果摘要和测试源代码保存在本仓库；本机凭据、会话 ID、账户标识和请求正文未写入项目文件。上游许可证和依赖面清单见[许可证审查](LICENSING-REVIEW.md)。

## 选型结论

1. **工作流与状态**：Phase 1 原型建议采用轻量独立核心（TypeScript、Bun、SQLite、Git 检查点），由控制器拥有额度与工作区写入租约；真实 Codex 写入与跨 Agent 恢复已取得通过证据，该结论仍待负责人复核后定版。Archon 保留为工作流及 GitHub 集成参考，不作为当前主运行器。
2. **模型与遥测**：Magpie 作为可选网关保留；Codex 与 OpenCode 原生接入也保留。Magpie 能为测试请求记录请求模型、服务模型、账户引用及其自身价格计算；外部账单金额必须与其分开，无法验证时记为 `UNKNOWN`。不得把“免费”目录标签或 Magpie 的零价格记录当成服务商零账单证明。
3. **平台边界**：当前进程回收 PoC 只在 Windows 验证。Linux、macOS、WSL2、生产仓库文件权限、网络隔离、GitHub 写操作幂等性均未验证。

## Phase 1 开工门禁

**判定：技术门禁有条件通过，Phase 1 核心底座已启动。** 硬阻塞证据已补齐，剩余工作转入 Phase 1 验收与限制复核：

1. **已完成**：Codex App Server 的零推理 `command/exec` 预检通过，真实 Agent 回合内也成功启动 shell 并写入 `app.txt`。
2. **已完成**：Codex Agent 生成文件检查点后，OpenCode 在同一 Worktree 接续；旧写入进程为 0，改动保留，工作区断言及现有回归通过。
3. **N/A / Phase 1 前置条件**：Phase 1 MVP 不以商用路由组为硬依赖。若后续要求商用路由组，需获得可配置的测试 Provider 权限，并将 Magpie 价格估算与服务商账单分别核对；当前隔离路由只使用本地 Qwen。
4. **保持约束**：许可证范围按[审查清单](LICENSING-REVIEW.md)执行，工具保持外部安装、不打包；若要打包，再对具体发布制品完成 SBOM 与 NOTICE 复核。
5. **已完成路由授权记录**：负责人已允许 Phase 1 使用 Magpie 路由模型；原生 ChatGPT 路径和服务商账单仍记录为限制，详见[Phase 1 说明](PHASE-1.md)。

Phase 1 核心底座已启动。不把本次测试适配器或本地模拟上游描述为生产可用平台，也不运行 mcarplay 真实 Issue。
