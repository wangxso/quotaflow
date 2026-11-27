# QuotaFlow Phase 0 门禁收口记录

**日期** 2026-11-27

**状态** 技术门禁有条件通过；真实 Codex Agent 写入、检查点恢复和 OpenCode 接续已完成。负责人已允许 Phase 1 使用 Magpie 路由模型，Phase 1 核心底座已启动。

## 本轮目标

不扩大 Phase 1 范围，只补齐 `docs/PHASE-0.md` 中的硬阻塞证据：

1. App Server 本地工作区运行时能启动 shell。
2. Codex Agent 在回合内实际写入，生成 Git 检查点。
3. OpenCode 在旧写入者退出后接续，改动和测试结果保留。

## 已完成

- 为 App Server 探针增加 `stdio` 和 managed daemon 两种 transport；`native-codex.ts` 在创建线程或发起模型回合前，先执行零推理 shell 预检。
- 新增 `poc/app-server-preflight.mjs`，使用 App Server 的 `command/exec` 在 `workspaceWrite` 策略下启动 PowerShell、写入并读回 `41`。该路径不创建线程、不发起模型推理。
- 2026-11-27 在 Codex 0.172.0 上复测：`stdio` transport 连续 10/10 次通过；启动 managed daemon 后，`windowsSandbox` 为 `ready`，再连续 5/5 次通过。
- `codex doctor` 结果从包含认证和 runtime CDN 失败，变为 21 项通过、4 项警告、0 项失败；警告为 Dev Drive、可选配置、MCP 配置和 3 个历史线程索引问题。
- managed daemon 的 `codex app-server proxy` 在当前环境初始化超时，因此不作为本轮门禁通过依据；主线继续使用经过验证的直连 `stdio`。
- 2026-11-27 完成一次真实 Codex Agent 写入：`turnStatus=completed`，`app.txt=41`，仅预期文件改变，生成检查点 `4dd50cc7c920b6c587c99dcd3d4257155a0d0d27`，App Server 重启后线程恢复成功。
- 同一 Worktree 中完成 OpenCode 接续：免费模型读取 `app.txt=41`，写入 `answer.txt` 的字节为 `52,50,10`，即 `42\n`；工具序列为 `read → write → bash`，退出码 0，成本 0。
- 交接时匹配该 Worktree 的旧 Codex 写入进程为 0，OpenCode 进程为 0；工作区仅有 `M app.txt` 和未跟踪的 `answer.txt`。最终检查点 `ab273a2744d1476d241d4ffdf5bfc65990f7058c` 已验证。
- 当前完整权限环境复跑：确定性恢复 8/8，通过 56 断言；新增 App Server 预检 2/2，通过 7 断言；合计 10/10、63 断言。
- 负向预检：用不存在的 `QUOTAFLOW_PREFLIGHT_SHELL` 运行 `native-codex.ts`，App Server 返回 `-32603`，`inferenceTurnsRequested=0`，未创建线程或发起回合。

## 重要限制

- Codex 写入实际走了 Magpie 的 `opencode-go/deepseek-v4.1-flash`，不是原生 ChatGPT 模型。账户读取成功只证明本机有 ChatGPT 凭据，不能证明该回合由原生订阅计费；服务商账单仍为 `UNKNOWN`。
- OpenCode 接续使用 `magpie/opencode-go/hy4-flash-free`，Magpie 记录成本为 0，但免费标签不等于服务商账单为 0。
- 商用 Routing Group 未验证。Phase 1 MVP 不依赖它时，记为 `N/A / Phase 1 前置条件`；接入付费路由前另行授权并核对账单。
- Windows DTDL、真实仓库权限、网络隔离和 GitHub 写操作仍未验证，不得把测试适配器描述为生产沙箱。

## 证据

```powershell
node poc/app-server-preflight.mjs $quotaCodex --transport stdio
node poc/app-server-preflight.mjs $quotaCodex --transport stdio
# 可重复执行；每次输出 inferenceCalls: 0
```

脱敏结果见 [预检证据](evidence/phase0-app-server-preflight-2026-11-27.json) 和[交接证据](evidence/phase0-codex-opencode-handoff-2026-11-27.json)。

本轮已经补上 Agent 回合内 shell、实际文件写入、检查点、重启恢复和跨 Agent 接续。技术门禁有条件通过；路由授权已记录，Phase 1 核心底座已启动，剩余项转入 Phase 1 验收与限制复核。

## 下一步

1. 项目负责人复核本记录与更新后的 `PHASE-0.md`、`PLAN.md` 和 ADR 状态。
2. **已完成**：负责人已允许 Phase 1 继续使用 Magpie 路由模型，授权记录见[Phase 1 说明](PHASE-1.md)。若要求原生 ChatGPT 模型，仍需用 `QUOTAFLOW_CODEX_MODEL` 和 `QUOTAFLOW_CODEX_OPENAI_BASE_URL` 覆盖本机配置并单独验证。
3. 商业 Routing Group 若 Phase 1 不需要，明确记为 `N/A / Phase 1 前置条件`；需要时另行取得 Provider 权限和账单证据。
4. 在 Phase 1 迭代中固定本轮使用的 Codex、OpenCode、Magpie 版本和限制说明。

## 决策规则

- **不豁免**：不把 CLI 单文件写入、控制器写入或零推理 `command/exec` 当作 Agent 回合内写入通过。
- **不重复烧额度**：真实回合失败后先保存服务端 stderr、命令事件和错误码；同一阻塞未定位前不反复重试。
- **超时升级**：若受控回合在明确时限内无法形成写入和交接证据，提交 ADR 决定改用 CLI 执行适配器或缩减跨 Agent 范围，由负责人批准。
