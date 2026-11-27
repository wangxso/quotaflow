# QuotaFlow Phase 2 · GitHub 开发闭环

**状态** 已启动 · 2026-11-28

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

`--materialize <repo>` 只会为 `independent_review`、`review_fix` 或 `ci_fix` 创建任务。任务 ID 由 `actionKey` 稳定派生，因此 Webhook 重放或重复执行门禁不会创建重复任务。任务初始检查点固定为 PR HEAD，仓库中必须已经存在当前 base／head 提交，否则命令会在写库前失败。执行沿用 QuotaFlow 的每任务最多 3 次尝试和配置预算，任务提示禁止 Agent push、评论、批准、合并或修改仓库权限。`independent_review` 使用 SQLite v9 的任务级只读模式，Agent 不能写入 worktree，其他 Adapter 如果无法保证只读会被 Worker 拒绝，完成后还会再次校验 HEAD 和工作树。Draft、冲突、刷新证据和人工合并只作为 `human_required` 返回，不会派发。 [物化与执行证据](evidence/phase2-github-materialization-2026-11-28.json)

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

SQLite v8 新增 `github_deliveries` 和 `github_gate_results`，v9 为任务增加 `access_mode`。同一 GitHub delivery 重放只返回原结果，不会重复处理。相同事件内容即使换用另一个 delivery ID，也通过逻辑事件键去重。同一 delivery ID 携带不同内容会被拒绝。Gate 结果按仓库、PR、HEAD SHA 和策略哈希保存，变更 HEAD 会生成独立记录。

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

本地 HTTP 监听器使用配置中的 `githubWebhook`，或通过命令行覆盖：

```sh
GITHUB_WEBHOOK_SECRET=... bun run src/cli.ts github serve-webhook
# GET /healthz -> {"status":"ok"}
# POST /github/webhook -> 202 accepted / 200 duplicate
```

监听器返回稳定的 HTTP 状态：新事件 `202`，重复事件 `200`，签名无效 `401`，载荷过大 `413`，不支持的事件 `422`，已知 delivery 内容冲突 `409`。GitHub 建立 Webhook 时发送的签名 `ping` 返回 `200`，业务事件与健康检查都不回显 Secret 或原始载荷。

当前支持 `pull_request`、`check_run` 和 `pull_request_review`。事件会归一化为仓库、PR、HEAD SHA、action 和原始字节哈希。相同 delivery 或相同逻辑事件重放不会重复处理，冲突内容会被拒绝。签名无效或载荷超过 2 MB 时不会写库。 [Webhook 验证证据](evidence/phase2-github-webhook-2026-11-27.json)

## 尚未完成

- 公网 TLS Webhook 回调部署和反向代理。
- 在物化前自动抓取 PR HEAD／base 到本地 Git 仓库并校验提交可用性。
- Check-run 日志抓取、失败分类细节和同 SHA 复跑绑定。
- 写入应答丢失、重复 Webhook、越权请求和凭据轮换演练。
- 后续 Review–Fix／CI 修复任务的完整执行、复跑和门禁闭环。

## 下一里程碑

1. 将本地监听器部署到受控公网反向代理。
2. 对后续 Review–Fix／CI 修复任务重复执行、复跑和门禁闭环。
3. 接入 Check-run 日志抓取和失败分类。
4. Phase 2 核心验收完成后进入 Phase 3 Dashboard 与部署。
