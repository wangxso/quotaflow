# Phase 0 复跑说明

## 本地恢复试验

以仓库根目录为当前目录。使用 Windows、Git、Bun 1.4.5 及 Windows PowerShell。示例和测试自动创建专用临时仓库、SQLite 状态库和 Git Worktree。可用 `QUOTAFLOW_LAB_DIR` 指定保留临时产物的目录。

```powershell
bun test poc/phase0.test.ts
bun run poc/demo.ts
```

示例输出包含额度拒绝后的两个尝试、写入者停止凭证、检查点 SHA 和任务结果。`fixture-codex` 与 `fixture-opencode` 是合成执行器。Windows Job Object 控制进程生命周期，记录进程全部退出后才允许交接。试验 Worktree 含固定的合成文件，生产文件权限隔离需要单独验证。

## 只读接口探测

下列命令仅探测账户状态、额度和遥测。报告保留字段和数量，不输出账户标识、凭据、请求正文或会话 ID。

```powershell
node poc/live-probe.mjs codex
node poc/live-probe.mjs magpie http://127.0.0.1:3425
```

Magpie 地址使用本机运行实例的实际端口。需要只读令牌的实例通过 `QUOTAFLOW_MAGPIE_READ_TOKEN` 提供对应凭据。

## 真实运行对照

使用报告中核对过的发行版本。以下变量指向待测 CLI 和模型权重文件。Archon 的脚本节点需要在提供的目录中找到名为 `bun.exe` 的 Bun 程序。

```powershell
bun run poc/archon-probe.ts $quotaArchon $quotaBun
bun run poc/native-codex.ts $quotaCodex structured
bun run poc/gateway-probe.ts $quotaMagpie $quotaOpenCode $quotaLlamaServer $quotaModel
```

- Codex 脚本每次最多发送一个推理回合。它先验证原生 Plus 订阅、两个额度窗口及关闭信用余额，并在只读 Agent 回合结束后校验结构化响应，由控制器写入合成仓库。`agent-write` 模式复验 Agent 的受限写入。
- Magpie 探测在临时目录启动便携实例，只配置环回地址的上游。一个上游固定返回 503，另一个是使用实际 GGUF 权重的 llama.cpp。OpenCode 使用独立配置和本地资源池。可把 Codex 合成 Worktree 的绝对路径作为最后一个参数，以该工作区的 `app.txt` 作为真实交接输入。
- Archon 对照用一条真实工作流验证创建 Worktree、节点失败持久化及同一 Worktree 续跑。`resume --json` 记录预览结果，随后由明确的执行命令恢复。

实际工具版本、通过项和仍需验证的运行条件见[Phase 0 结果](../docs/PHASE-0.md)。
