# QuotaFlow Phase 2 · GitHub 开发闭环

**状态** 核心闭环完成 · 2026-11-28

## 首个真实试点

QuotaFlow 已在 `wangxso/mcarplay` Issue #82 上创建独立 Worktree，由 Codex 经 Magpie 免费模型完成 iAP2 消息目录修正，并由控制面运行完整仓库门禁。提交 `abc4c5b` 形成 Draft PR [#141](https://github.com/wangxso/mcarplay/pull/141)。两次 Android CI 和 GitGuardian 均对同一 HEAD 通过。详细记录见 [mcarplay 试点证据](evidence/phase1-mcarplay-issue-82-2026-11-27.json)。

## Pull Request 门禁

`github gate` 接收一个经过结构校验的 Pull Request 快照，输出 `ready_for_human_merge` 或 `blocked`。当前规则如下：

- PR 必须为 Open，且不能仍处于 Draft。
- GitHub 必须报告 `mergeable=mergeable`。
- 指定检查按名称只采用当前 HEAD 上最新一次结果。旧 HEAD 的检查和审查不会复用。
- 所有必需检查都必须为 `completed/success`，缺失、运行中、失败或取消都会阻断。
- 独立批准必须绑定当前 HEAD。PR 作者自批默认不计入，较新的 `CHANGES_REQUESTED` 会覆盖旧批准。
- Bot 批准默认不计入。`githubApproval.allowBotApprovals=true` 或 `--allow-bot-approvals` 可以显式允许，门禁结果和策略哈希会保存该选择。
- 输出始终保留 `humanMergeRequired=true`。门禁只允许进入人工合并，不执行自动合并。

`github gate` 还会输出下一步动作计划。动作按当前阻断阶段排序，避免同时派出多个写任务。CI 失败和 `CHANGES_REQUESTED` 会合并成一个 Review–Fix 任务提示，修复完成后再次运行门禁才会生成独立审查动作。Draft、冲突、HEAD／base 变化和最终合并保留为人工动作。计划包含稳定的 `actionKey`、优先级、原因和可直接交给 Agent 的任务提示。

`--materialize <repo>` 只会为 `independent_review`、`review_fix` 或 `ci_fix` 创建任务。任务 ID 由 `actionKey` 稳定派生，因此 Webhook 重放或重复执行门禁不会创建重复任务。任务初始检查点固定为 PR HEAD，仓库中必须已经存在当前 base／head 提交，否则命令会在写库前失败。执行沿用 QuotaFlow 的每任务最多 3 次尝试和配置预算，任务提示禁止 Agent push、评论、批准、合并或修改仓库权限。`independent_review` 使用 v9 引入的任务级只读模式，Agent 不能写入 worktree，其他 Adapter 如果无法保证只读会被 Worker 拒绝，完成后还会再次校验 HEAD 和工作树。Draft、冲突、刷新证据和人工合并只作为 `human_required` 返回，不会派发。 [物化与执行证据](evidence/phase2-github-materialization-2026-11-28.json)

Webhook 自动物化必须通过 `githubProjects` 显式映射。未映射仓库返回 `not_configured`，fork PR 和未命中 `branchPrefixes` 的分支返回 `ignored`，这些情况不会创建任务。命中映射后，服务会从配置 remote 拉取缺失的 base/head 提交并复用 CLI 的幂等任务物化。

```json
{
  "githubProjects": [{
    "repository": "wangxso/mcarplay",
    "repoPath": "/path/to/local/mcarplay",
    "branchPrefixes": ["quotaflow/"],
    "remote": "origin",
    "maxCiRerunsPerHead": 1
  }]
}
```

检查快照时使用：

```sh
bun run src/cli.ts github snapshot \
  --repo wangxso/mcarplay \
  --pull-number 141 > pr.json

bun run src/cli.ts github gate pr.json \
  --delivery-id delivery-141 \
  --expected-head abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48 \
  --expected-base daf67e87a72aa9033a4d62f88e9a9d05ce047d9e \
  --require-check "Check and build debug APK" \
  --require-check "GitGuardian Security Checks" \
  --required-approvals 1 \
  --materialize /path/to/repository
```

`github snapshot` 从 GitHub REST 读取 PR 元数据、当前 HEAD 的 check-runs 和正式 Reviews。默认不要求凭据，适合公开仓库；私有仓库或更高 API 限流可通过 `--token-env` 指定环境变量，默认名称为 `GITHUB_TOKEN`。企业 API 可用 `--api-url` 指向 HTTPS 端点或本机回环测试服务。GitHub 首次返回 `mergeable=null` 时会在有界等待后重试，不会立即把计算延迟误判为冲突。 [REST 快照证据](evidence/phase2-github-api-snapshot-2026-11-28.json)

快照文件格式为：

```json
{
  "repository": "owner/repo",
  "update": {
    "number": 141,
    "state": "OPEN",
    "draft": false,
    "mergeable": "MERGEABLE",
    "authorLogin": "owner",
    "baseRef": "main",
    "headRef": "feature",
    "baseSha": "<40 hex>",
    "headSha": "<40 hex>",
    "checks": [],
    "reviews": []
  }
}
```

## 幂等与审计

SQLite v8 新增 `github_deliveries` 和 `github_gate_results`，v9 为任务增加 `access_mode`，v10 新增按仓库、PR、HEAD SHA 和 workflow run 键控的 `github_ci_reruns`。同一 GitHub delivery 重放只返回原结果，不会重复处理。相同事件内容即使换用另一个 delivery ID，也通过逻辑事件键去重。同一 delivery ID 携带不同内容会被拒绝。Gate 结果按仓库、PR、HEAD SHA 和策略哈希保存，变更 HEAD 会生成独立记录。

实时快照验证中，PR #141 的三项当前 HEAD 检查均成功。2026-11-28 使用 `opencode-go/hy4-flash-free` 对同一 HEAD 完成 QuotaFlow 内部只读审查，报告为 `P1×0, P2×0, P3×0`；源仓库与审查 worktree 均保持干净。PR 随后转为 Ready，HEAD／base 未变，`mergeable=mergeable`。

项目明确采用 Bot 批准路线。`quotaflow-review-gate-wangxso` GitHub App 仅安装到 `mcarplay`，拥有 Contents read、Metadata read 和 Pull requests write。它通过 9 分钟 JWT 换取单仓库短时令牌，并对当前 HEAD 提交 Review ID `6091237629`。门禁将 Review 识别为 `authorType=bot`，在显式允许后计为 1 条独立批准并进入 `ready_for_human_merge`。GitHub 仓库没有分支保护或 Ruleset，因此 GitHub 的 `reviewDecision` 仍为空，合并判断由 QuotaFlow 的显式策略完成。 [Bot 批准证据](evidence/phase2-github-bot-approval-2026-11-28.json)

仓库管理员随后人工合并 PR。合并提交为 `23033142a38d87441ed5632bc4c9d9ac821ccd61`，本地 `main` 已同步并确认工作树干净。源分支已删除，审核与实现使用过的两个 detached Worktree 已移除，临时试点目录已清理。 [合并证据](evidence/phase2-github-merge-2026-11-28.json)

## Signed Webhook 入口

Webhook 在解析 JSON 前对原始请求字节执行 HMAC-SHA256 验证，并使用常量时间比较。Secret 只从 `--secret-env` 指定的环境变量读取，默认名称为 `GITHUB_WEBHOOK_SECRET`，不会写入输出或数据库。

```sh
GITHUB_WEBHOOK_SECRET=... bun run src/cli.ts github webhook payload.json \
  --event pull_request \
  --delivery-id delivery-id \
  --signature sha256=...
```

本地 HTTP 监听器使用配置中的 `githubWebhook`，或通过命令行覆盖。`fetchGate` 默认为 `true`，验签后会调用 GitHub REST 获取当前 PR 快照，校验事件 HEAD/base，并保存 Gate 与动作计划。

`githubWebhook.requiredChecks` 可显式限定 Webhook Gate 使用的检查名。未配置时沿用当前 HEAD 的全部最新检查；配置后只读取指定的当前 HEAD 检查，适合将试点门禁与其他仓库工作流隔离。

```sh
GITHUB_WEBHOOK_SECRET=... bun run src/cli.ts github serve-webhook
# GET /healthz -> {"status":"ok"}
# POST /github/webhook -> 202 accepted / 200 duplicate
```

监听器返回稳定的 HTTP 状态：新事件 `202`，重复事件 `200`，签名无效 `401`，载荷过大 `413`，不支持的事件 `422`，已知 delivery 内容冲突 `409`。GitHub 建立 Webhook 时发送的签名 `ping` 返回 `200`，业务事件与健康检查都不回显 Secret 或原始载荷。

当前支持 `pull_request`、`check_run` 和 `pull_request_review`。事件会归一化为仓库、PR、HEAD SHA、action 和原始字节哈希。相同 delivery 或相同逻辑事件重放不会重复处理，冲突内容会被拒绝。签名无效或载荷超过 2 MB 时不会写库。installation 生命周期事件验签后返回 200 并忽略。未关联 PR 的主分支 `check_run` 返回 `200 ignored`，避免 GitHub 将预期忽略的事件持续标记为失败。稳定入口为 `https://quotaflow-hooks.wangxso.com/github/webhook`，Cloudflare Named Tunnel 将流量转发到本机 `127.0.0.1:8787`。 [本地 Webhook 验证](evidence/phase2-github-webhook-2026-11-27.json) · [Cloudflare 部署说明](deployment/cloudflare-tunnel.md)

## CI 失败分流

失败 Check 的 GitHub Actions `detailsUrl` 会提取 job ID。控制面使用 GitHub App 短时 installation token 获取最多 3 个 job 的日志，单日志上限 256 KiB，并清除 ANSI 控制符。日志先脱敏 GitHub Token、Authorization、`token/secret/password/api_key` 赋值和 PEM 私钥，再分类为：

- `code_or_test`：编译、测试、断言、lint 等代码或测试失败。
- `infrastructure`：runner 失联、磁盘、内存、网络等环境问题。
- `permissions_or_configuration`：403、权限不足或集成配置错误。
- `cancelled`：检查被取消。
- `unknown`：证据不足或日志接口不可用。

`ci_fix` 或 `review_fix` 任务提示会附上当前 HEAD 的脱敏分类摘要，并把日志明确标记为不可信诊断数据。GitHub App token 按 installation 缓存，在过期前自动刷新。真实 job `140707721837` 的 164144 字节日志已成功下载并分类为 `code_or_test`。 [CI 分流证据](evidence/phase2-github-ci-triage-2026-11-28.json)

控制面从同一 `detailsUrl` 提取 workflow run ID。只有一次 run 中全部已分类失败都属于 `infrastructure` 或 `cancelled`，并且所有失败 Check 都已完成分类时，才会请求 `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`。请求前会重新读取 PR 快照和 workflow run，二者 `head_sha` 都必须仍与 Gate HEAD 相同。`code_or_test`、`permissions_or_configuration`、`unknown` 和 SHA 漂移不会自动复跑。

每个仓库可通过 `maxCiRerunsPerHead` 设置同一 HEAD 的复跑上限，默认 1，允许 0–5。占用记录在外部 POST 前通过 SQLite 即时事务写入，键为仓库、PR、HEAD SHA 和 workflow run ID。重复 Webhook、并发请求或进程在应答前退出都不能再次放大同一个 HEAD 的复跑次数。重跑请求成功或失败的记录都会保留，失败记录按保守策略占用额度，由人工审计后处理。

GitHub App installation 已将 Actions 权限从 read 提升为 read and write，并在安装侧完成批准。Webhook 进程重启后，使用临时 Draft PR #146 的受控基础设施失败完成真实复跑：API 返回 `201`，workflow run attempt 从 1 增至 2，新 Check `140869955267` 仍绑定原 HEAD `e25f1da`。随后以另一个 delivery 重放新快照，返回既有 claim 的 `duplicate`，request count 保持 1，run attempt 仍为 2。该临时 PR 和分支已关闭、删除。

代码级验收覆盖成功复跑、PR HEAD 漂移、workflow run HEAD 漂移、次数耗尽、并发重复投递、代码/测试同 run 禁止复跑、分类不完整、显式零限额、API 失败和 v9→v10 迁移；macOS 与 Linux 均为 161 通过、1 个平台性 skip、0 失败。真实 Actions read/write 与同 HEAD 复跑结果见[复跑闭环证据](evidence/phase2-github-ci-rerun-2026-11-28.json)。

## 真实 CI 修复闭环

2026-11-28 在临时 Draft PR #147 上完成真实 `ci_fix` 闭环。初始 HEAD `7099724` 的 Python 测试产生 `code_or_test` 失败，稳定 Cloudflare Webhook 收到当前 HEAD 快照和脱敏 Actions 日志后，只创建一个优先级 120 的 CI 修复任务。免费 Magpie 通道的 Codex App Server 在隔离 Worktree 中修改单个 Python 文件，写入交接笔记，发布 `activeProcesses=0` 停止凭证，并形成检查点 `28be6be`。

控制面审查该 checkpoint 后，将单行修复提交 `f59d37d` 写回临时 PR。新的 `controlled-code-failure` Check 对同一 PR 的最终 HEAD 成功；重新运行门禁时，阻断项只剩 Draft 和独立审查，CI 阻断已消失。临时 PR、远端分支和两个 Worktree 随后全部清理。本次 Codex 调用没有可归属的请求级 Magpie 用量行，Provider 账单仍为 `UNKNOWN`。 [CI 修复闭环证据](evidence/phase2-github-ci-fix-loop-2026-11-28.json)

## 投递与凭据故障门槛

Delivery 去重现在使用原始 Webhook 字节哈希，刷新后的 PR 快照单独记录为 Gate 审计哈希。测试先完成一次任务物化后丢弃 HTTP 响应，再以相同 delivery 重放，第二次返回 `duplicate` 且最终只有一个任务。即使两次请求间 REST 快照发生变化，也不会错误返回 `409`。

公网无权限签名返回 `401`，超过 2 MB 的载荷返回 `413`，不支持的事件返回 `422`。fork、未命中 `branchPrefixes` 的分支和未映射仓库均不会创建任务。隔离端口使用旧 secret 时签名 `ping` 返回 `200`，重启到新 secret 后旧签名返回 `401`、新签名返回 `200`。演练使用临时 secret 和数据库并已清理，生产 secret 未改变。

双平台全量测试为 164 通过、1 个平台性 skip、0 失败、743 断言。Phase 2 的写入应答丢失、重复投递、越权拒绝和 secret 轮换门槛均已通过。[故障门槛证据](evidence/phase2-webhook-hardening-2026-11-28.json)

## 后续扩展

- 在不同仓库和多项目映射上扩大真实运行样本。
- 在维护窗口中执行一次生产 Webhook secret、GitHub App private key 和 Cloudflare Tunnel 凭据轮换。

## 下一里程碑

1. 进入 Phase 3 Dashboard、多项目管理和部署体验。
2. 用真实运行数据验证 Dashboard 与 CLI 的状态一致性。
