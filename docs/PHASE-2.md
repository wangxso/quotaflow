# QuotaFlow Phase 2 · GitHub 开发闭环

**状态** 已启动 · 2026-11-27

## 首个真实试点

QuotaFlow 已在 `wangxso/mcarplay` Issue #82 上创建独立 Worktree，由 Codex 经 Magpie 免费模型完成 iAP2 消息目录修正，并由控制面运行完整仓库门禁。提交 `abc4c5b` 形成 Draft PR [#141](https://github.com/wangxso/mcarplay/pull/141)。两次 Android CI 和 GitGuardian 均对同一 HEAD 通过。详细记录见 [mcarplay 试点证据](evidence/phase1-mcarplay-issue-82-2026-11-27.json)。

## Pull Request 门禁

`github gate` 接收一个经过结构校验的 Pull Request 快照，输出 `ready_for_human_merge` 或 `blocked`。当前规则如下：

- PR 必须为 Open，且不能仍处于 Draft。
- GitHub 必须报告 `mergeable=mergeable`。
- 指定检查按名称只采用当前 HEAD 上最新一次结果。旧 HEAD 的检查和审查不会复用。
- 所有必需检查都必须为 `completed/success`，缺失、运行中、失败或取消都会阻断。
- 独立批准必须绑定当前 HEAD。PR 作者自批默认不计入，较新的 `CHANGES_REQUESTED` 会覆盖旧批准。
- 输出始终保留 `humanMergeRequired=true`。门禁只允许进入人工合并，不执行自动合并。

`github gate` 还会输出下一步动作计划。动作按当前阻断阶段排序，避免同时派出多个写任务。CI 失败和 `CHANGES_REQUESTED` 会合并成一个 Review–Fix 任务提示，修复完成后再次运行门禁才会生成独立审查动作。Draft、冲突、HEAD／base 变化和最终合并保留为人工动作。计划包含稳定的 `actionKey`、优先级、原因和可直接交给 Agent 的任务提示。

检查快照时使用：

```sh
bun run src/cli.ts github gate pr.json \
  --delivery-id delivery-141 \
  --expected-head abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48 \
  --expected-base daf67e87a72aa9033a4d62f88e9a9d05ce047d9e \
  --require-check "Check and build debug APK" \
  --require-check "GitGuardian Security Checks" \
  --required-approvals 1
```

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

SQLite v8 新增 `github_deliveries` 和 `github_gate_results`。同一 GitHub delivery 重放只返回原结果，不会重复处理。相同事件内容即使换用另一个 delivery ID，也通过逻辑事件键去重。同一 delivery ID 携带不同内容会被拒绝。Gate 结果按仓库、PR、HEAD SHA 和策略哈希保存，变更 HEAD 会生成独立记录。

实时快照验证中，PR #141 的三项当前 HEAD 检查均成功，但门禁因 `draft` 和 `independent_review_missing` 保持阻断。重复投递保持相同 `updatedAt`，已验证 delivery 与逻辑事件两层幂等。 [门禁证据](evidence/phase2-github-gate-2026-11-27.json)

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

- GitHub App 或最小权限凭据、公网 TLS 回调部署、反向代理和自动拉取 PR 快照。
- 将动作计划物化为受预算和轮次限制的 QuotaFlow 任务。
- Check-run 日志抓取、失败分类细节和同 SHA 复跑绑定。
- 写入应答丢失、重复 Webhook、越权请求和凭据轮换演练。
- Draft 转 Ready、人工批准与合并操作。当前所有合并保持人工执行。

## 下一里程碑

1. 接入 GitHub App 凭据，并将本地监听器部署到受控公网反向代理。
2. 将 Review–Fix 动作计划物化为任务，并限制轮次与预算。
3. 在 PR #141 获得独立审查后重新评估门禁，保持人工合并。
4. Phase 2 核心验收完成后进入 Phase 3 Dashboard 与部署。
