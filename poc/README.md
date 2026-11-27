# Phase 0 复跑说明

## 本地恢复试验

以仓库根目录为当前目录。需要 Git 和 Bun 1.4.5。Windows 使用 Windows PowerShell，macOS 使用 Xcode 或 Command Line Tools 提供的 `/usr/bin/cc`。示例和测试自动创建专用临时仓库、SQLite 状态库和 Git Worktree。可用 `QUOTAFLOW_LAB_DIR` 指定保留临时产物的目录。

```sh
bun test poc/phase0.test.ts
bun run poc/demo.ts
```

示例输出包含额度拒绝后的两个尝试、写入者停止凭证、检查点 SHA 和任务结果。`fixture-codex` 与 `fixture-opencode` 是合成执行器。Windows 用 Job Object 验证进程停止，macOS 验证命令及其同组子进程停止。通过验证后才允许交接。 [macOS 监督范围](../docs/PHASE-1.md#macos-本地命令验证)

## 只读接口探测

下列命令仅探测账户状态、额度和遥测。报告保留字段和数量，不输出账户标识、凭据、请求正文或会话 ID。

```powershell
node poc/live-probe.mjs codex
node poc/live-probe.mjs magpie http://127.0.0.1:3425
```

Magpie 地址使用本机运行实例的实际端口。需要只读令牌的实例通过 `QUOTAFLOW_MAGPIE_READ_TOKEN` 提供对应凭据。

## App Server 零推理预检

该预检使用 App Server 的 `command/exec`，在 `workspaceWrite` 策略下写入和读回文件。Windows 使用 PowerShell，macOS 使用 `/bin/sh`。预检的模型推理次数为 0。

```sh
node poc/app-server-preflight.mjs codex --transport stdio
```

输出应包含 `inferenceCalls: 0`、`commandExec.status: "completed"`、`exitCode: 0` 和 `fileWritten: true`。可通过 `QUOTAFLOW_PREFLIGHT_SHELL` 指定 PowerShell 可执行文件；`--keep` 保留临时工作区用于排查。

`--transport daemon` 使用 `codex app-server proxy` 连接已启动的 managed daemon。当前 0.172.0 复测中该路径初始化超时，因此默认使用 `stdio`。

## Codex 受监督停止复跑

该 smoke 通过 Job Object 监督器启动 `codex app-server`，完成一次零推理初始化后关闭，并要求监督器发布 `activeProcesses=0` 的停止凭证。

```powershell
bun run poc/codex-app-server-guarded-smoke.ts $quotaCodex
```

输出应包含 `initialized: true`、`inferenceTurnsRequested: 0`，以及 `stop.activeProcesses: 0`、`stop.exitCode: 0`。缺少凭证或仍有活动进程时脚本失败。

## 真实运行对照

使用报告中核对过的发行版本。以下变量指向待测 CLI 和模型权重文件。Archon 的脚本节点需要在提供的目录中找到名为 `bun.exe` 的 Bun 程序。

```powershell
bun run poc/archon-probe.ts $quotaArchon $quotaBun
bun run poc/native-codex.ts $quotaCodex structured
bun run poc/native-codex.ts $quotaCodex agent-write
bun run poc/gateway-probe.ts $quotaMagpie $quotaOpenCode $quotaLlamaServer $quotaModel
```

- Codex 脚本每次最多发送一个推理回合。它先执行零推理 shell 预检，再验证当前 ChatGPT 账户、两个额度窗口及关闭信用余额；预检失败时不会创建线程或消耗推理。只读模式在回合结束后校验结构化响应，由控制器写入合成仓库。`agent-write` 模式复验 Agent 的受限写入。
- 模型与计费归属由本机配置决定，不能根据账户类型推断为原生通道。可用 `QUOTAFLOW_CODEX_MODEL` 和 `QUOTAFLOW_CODEX_OPENAI_BASE_URL` 显式覆盖；用 `QUOTAFLOW_BILLING_ATTRIBUTION` 标记已知归属，否则输出 `UNKNOWN`。
- 可选的第三个参数是 `stdio` 或 `daemon` transport，默认 `stdio`。
- `agent-write` 必须由 Codex App Server 可用的本地工作区运行时执行 shell；若运行时不可用，回合即使完成也不能算作写入成功，控制器不会代写补成通过。
- Magpie 探测在临时目录启动便携实例，只配置环回地址的上游。一个上游固定返回 503，另一个是使用实际 GGUF 权重的 llama.cpp。OpenCode 使用独立配置和本地资源池。可把 Codex 合成 Worktree 的绝对路径作为最后一个参数，以该工作区的 `app.txt` 作为真实交接输入。
- Archon 对照用一条真实工作流验证创建 Worktree、节点失败持久化及同一 Worktree 续跑。`resume --json` 记录预览结果，随后由明确的执行命令恢复。

实际工具版本、通过项和仍需验证的运行条件见[Phase 0 结果](../docs/PHASE-0.md)。
