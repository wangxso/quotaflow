# QuotaFlow 建设计划

审查稿 · 2026-11-27

## 建议批准的开工范围

| 需要审查的取舍 | 建议 |
| --- | --- |
| 工作流底座 | Phase 0 优先验证 Archon 的公开插件与工作流接口。若无法通过进程终止、写锁、恢复或幂等门禁，采用轻量独立核心。选型以运行证据定版。 |
| 首版交付 | 单机 CLI 跑通 Codex → OpenCode 跨 Agent 续作，验证 Magpie 可选接入与额度租约。GitHub 闭环和 Web Dashboard 分别在 Phase 2、3 交付。 |
| 试点与权限 | Phase 0 使用本地临时 Git 仓库、测试适配器和经过授权的真实 Provider 最小请求，默认新增付费预算为 0。mcarplay 在 Phase 2 以单个低风险真实 Issue 进入试点，首个 PR 使用 Draft，合并由人审。 |

原建议是在审查通过后启动 Phase 0，并以锁定版本的技术选型报告、ADR、需求矩阵和可复跑 PoC 为交付。目前已按该范围执行；新增付费、扩大仓库写权限、重大架构变更或发布仍需另行授权。

### 本轮执行状态

方案获审后已执行 Phase 0 并提交 [验证报告](PHASE-0.md)、[PoC](../poc/README.md) 和[许可证审查](LICENSING-REVIEW.md)。确定性故障恢复用例通过。2026-11-27 已完成真实 Codex Agent 写入、检查点恢复和 OpenCode 接续，技术门禁有条件通过；Codex 实际经 Magpie 路由到第三方模型，原生 ChatGPT 路径、商用路由组和服务商账单仍未验证。Phase 1 已形成三平台监督、预算审计和恢复闭环。Phase 2 已启动，QuotaFlow 在 `mcarplay` Issue #82 上生成 Draft PR #141，完整 CI 通过，Pull Request 门禁、本地签名 Webhook 服务、Review–Fix／CI 动作计划和受限任务物化已接入。详见 [Phase 1](PHASE-1.md)、[Phase 2](PHASE-2.md) 与[门禁收口记录](PHASE-0-GATE-CLOSURE.md)。

2026-11-28 将 GitHub 动作计划接入 QuotaFlow 任务创建。只有独立审查、Review–Fix 和 CI 修复可物化为 Agent 任务；任务绑定 PR HEAD，按稳定动作键幂等，沿用每任务最多 3 次尝试和配置预算。独立审查使用 v9 引入的任务级只读模式，禁止不能保证只读的 Adapter，并在结束后拒绝任何工作树变化。人工 Ready、冲突处理、证据刷新与合并仍不派发给 Agent。PR #141 的内部只读审查已由免费 Magpie 路由完成，未发现阻断问题，源仓库和审查 worktree 均无改动；GitHub 官方 Review 仍为 0。详见 [Phase 2 证据](evidence/phase2-github-materialization-2026-11-28.json)。

同日增加 `github snapshot`，通过 GitHub REST 读取 Pull Request、当前 HEAD 的 check-runs 和正式 Reviews，并处理 `mergeable=null` 的计算延迟。公开 PR 可使用无认证读取，私有仓库或更高限流可通过 `--token-env` 注入凭据。PR #141 的自动快照得到当前 HEAD、3 条成功检查、`mergeable=mergeable` 和 0 条正式 Review，门禁结果与手工快照一致。详见 [REST 快照证据](evidence/phase2-github-api-snapshot-2026-11-28.json)。

PR #141 随后由有权限的操作者转为 Ready。重新拉取快照后，Draft 与 mergeable 阻断均消失，当前 HEAD 和 base 未变，3 条检查继续成功，门禁只剩 `independent_review_missing`。内部只读审查报告仍为 P1/P2/P3 全零，但 GitHub 正式 Review 数仍为 0，因此不满足人工合并门禁。详见 [Ready 门禁证据](evidence/phase2-github-ready-2026-11-28.json)。

同日按项目决策采用 Bot 批准路线。创建 `quotaflow-review-gate-wangxso` GitHub App，仅授予仓库内容只读、元数据和 Pull Request 读写权限，并只安装到 `mcarplay`。App 对 HEAD `abc4c5b` 提交正式 `APPROVED` Review 后，QuotaFlow 通过 `githubApproval.allowBotApprovals=true` 显式计入该批准并进入 `ready_for_human_merge`。Bot 批准默认关闭，代码会读取 Review 的 `authorType`，仅在配置或 `--allow-bot-approvals` 明确允许时计入。PR 仍未自动合并。详见 [Bot 批准证据](evidence/phase2-github-bot-approval-2026-11-28.json)。

仓库管理员随后完成人工合并。PR #141 于 2026-11-27T17:05:03Z 合并，合并提交为 `23033142a38d87441ed5632bc4c9d9ac821ccd61`。本地 `mcarplay/main` 已 fast-forward 到该 SHA，源分支、两个 detached Worktree 和临时试点目录已清理。详见 [合并证据](evidence/phase2-github-merge-2026-11-28.json)。

同日完成临时公网 Webhook 验证。GitHub App 订阅 `pull_request`、`check_run` 和 `pull_request_review`，安装权限增加 Checks read，并继续保留 Contents read、Metadata read、Pull requests write。公网 `/healthz` 和 GitHub `ping` 返回 200。签名 PR 事件会抓取当前 PR 快照、绑定事件 HEAD、保存 Gate 并返回动作计划。开放 PR #136 的验证事件生成 Draft、mergeability 和独立审查阻断。重复投递返回 200，错误签名返回 401，installation 生命周期事件返回 200 并忽略。之后入口迁移到稳定 Cloudflare Named Tunnel `https://quotaflow-hooks.wangxso.com/github/webhook`，由三个 macOS launchd 用户服务分别监督 webhook、tunnel 和每分钟健康检查。详见 [旧公网 Webhook 证据](evidence/phase2-github-webhook-e2e-2026-11-28.json) 与[Cloudflare 部署证据](evidence/phase2-cloudflare-tunnel-2026-11-28.json)。

随后完成 Webhook 到任务的代码闭环。`githubProjects` 必须显式配置仓库路径、分支前缀白名单和 remote，fork PR 默认拒绝。命中映射后，控制面按事件中的 base/head SHA 拉取缺失提交，再复用稳定动作键任务物化。人工合并、Ready、冲突与证据刷新继续返回 `human_required`。PR #136 分支未命中 `quotaflow/*` 白名单，公网签名事件返回 202 且 `taskMaterialization.status=ignored`，没有创建任务。临时 Git 仓库测试验证了精确 HEAD 拉取、只读 Review 任务创建、重复事件返回 `task_exists`、fork 与未授权分支拒绝。详见 [Webhook 任务物化证据](evidence/phase2-github-webhook-materialization-2026-11-28.json)。

随后接入 GitHub App 短时安装令牌和 Actions 日志分流。控制面从失败 Check 的 details URL 提取 job 和 workflow run ID，最多读取 3 个 job 的日志并限制为 256 KiB，清理 ANSI、脱敏令牌、Authorization、凭据赋值和 PEM 后分类为代码/测试、基础设施、权限配置、取消或未知。代码类失败的脱敏摘要会追加到当前 HEAD 的 Fix 任务提示。纯基础设施或取消 run 只有在 PR 与 run 的 HEAD 再次核验一致且每 HEAD 原子限额可用时才复跑；权限、代码/测试、未知、未完整分类和 SHA 漂移不会自动复跑。App installation 已接受 Actions read/write。真实 job `140707721837` 的 164144 字节日志成功下载并分类为 `code_or_test`；临时 Draft PR #146 的受控基础设施失败完成同 SHA 复跑，API 返回 201，run attempt 从 1 增至 2，新 Check 保持同一 HEAD，重复 delivery 未再次复跑。详见 [CI 分流证据](evidence/phase2-github-ci-triage-2026-11-28.json) 与[复跑闭环证据](evidence/phase2-github-ci-rerun-2026-11-28.json)。

随后在临时 Draft PR #147 完成真实 CI 修复闭环。新增 `githubWebhook.requiredChecks` 将试点门禁限定为 `controlled-code-failure`。初始 HEAD 的 Python 失败被分类为 `code_or_test`，稳定 Cloudflare Webhook 创建一个包含脱敏日志的 `ci_fix` 任务；免费 Magpie Codex 在隔离 Worktree 中完成单行修复，写入手交笔记和 `activeProcesses=0` 停止凭证，形成 checkpoint `28be6be`。控制面审查后将修复提交 `f59d37d` 写回临时 PR，新 Check 对最终 HEAD 成功，门禁只剩 Draft 与独立审查。临时 PR、分支和 Worktree 全部清理。详见 [CI 修复闭环证据](evidence/phase2-github-ci-fix-loop-2026-11-28.json)。

同日完成 Phase 2 故障门槛。GitHub delivery 去重改为绑定原始 Webhook 字节哈希，刷新后的 REST 快照哈希单独保存；丢弃首次 HTTP 响应后以同一 delivery 重试仍只创建一个任务，快照变化也不再产生错误 `409`。公网无权限签名返回 `401`，超限载荷返回 `413`，未支持事件返回 `422`，fork、未授权分支和未映射仓库均不建任务。隔离服务完成旧 secret、重启换 secret、旧签名拒绝、新签名接受的轮换演练。macOS 与 Linux 全量测试均为 164 通过、1 个平台性 skip、0 失败、743 断言。Phase 2 核心闭环完成，下一阶段进入 Phase 3 Dashboard。[故障门槛证据](evidence/phase2-webhook-hardening-2026-11-28.json)。

Phase 3 已交付本地 Dashboard 控制切片。`dashboard` 命令在 `127.0.0.1:8788` 提供 Overview、Tasks、GitHub 和 Budgets 视图，任务详情包含 attempt、实际模型、Worker Run、checkpoint、prompt、handoff、usage、预算租约和事件；默认拒绝非回环监听。项目与时间范围共享筛选上下文，Tasks 可组合 Lane，GitHub 可组合审查状态。受控任务动作使用 session、CSRF、精确确认、持久 requestId 幂等和审计。GitHub App 写操作进一步要求显式允许 Bot 批准、仓库与分支映射及完整 `owner/repo#pull@headSha` 确认。批准提交 current-head Review，合并重新拉取 PR 并重算 CI、审查和 mergeable 门禁后发送同一 head SHA。执行记录在 `github_deliveries` 中经历 `running`、`succeeded` 或 `failed`，未知结果不会自动重放。界面参考 T3 Code 的桌面密度和窄侧栏层级，但使用独立的 QuotaFlow 信息架构、颜色和组件，并保持严格 CSP、无第三方资源和 `textContent` 渲染。下一阶段使用一个受控 PR 完成真实 Dashboard 批准与合并演练，随后完成桌面发行、跨平台启动与备份恢复。[Phase 3 说明](PHASE-3.md) · [Dashboard 证据](evidence/phase3-dashboard-2026-11-28.json) · [组合筛选证据](evidence/phase3-dashboard-filters-2026-11-28.json) · [任务操作证据](evidence/phase3-dashboard-actions-2026-11-28.json) · [GitHub 写操作证据](evidence/phase3-dashboard-github-writes-2026-11-28.json) · [Worker 日志证据](evidence/phase3-dashboard-worker-log-2026-11-28.json)。

## Phase 0 · 调研与可行性验证

| 顺序 | 工作 | 通过证据 |
| --- | --- | --- |
| 0.1 | 固定九个候选的源码 SHA 和可运行候选的发布版本，核查 LICENSE、NOTICE、依赖清单及维护成本。按[选型矩阵](RESEARCH.md#phase-0-运行对照)逐项查源码，为关键特性设计实际运行对照。 | 固定树的根／嵌套许可证与锁文件面已初查；[依赖面审查](LICENSING-REVIEW.md)建议当前只以外部工具调用、不复制或分发上游制品。实际分发任何二进制前，先对该制品完成依赖 SBOM 与 notice 复核。 |
| 0.2 | 在同一临时仓库分别运行 Codex App Server 和 OpenCode 的版本化接口，验证事件、工作目录、取消、进程树退出、同一 Agent 恢复、实际模型与用量归属。 | 每个真实 Agent 各有一次最小成功任务记录。保存版本、脱敏事件、退出证据和结果，验证事件中断可判定。 |
| 0.3 | 对 Magpie 锁定版本核实可用模型、账户和健康、额度及历史、多个窗口、用量和成本、并发、路由组及实际模型。验证管理、遥测、推理凭据的可见范围，测试网关停用时原生通道仍可运行。 | 至少一个已授权 Provider 的真实请求和已知路由组，记录认证、请求关联及实际返回字段。无权限、无数据、过期或无可归属的字段记为 `UNKNOWN` 并保留原因。能够区分实际付费与成本估算。 |
| 0.4 | 用可控测试适配器注入额度耗尽、写入后异常退出、检查点提交前后崩溃、等待额度时重启、并发争抢和网关不可用。另以真实 Codex 与 OpenCode 验证交接路径，由控制器在 Codex 产生修改后触发切换。 | 逐次复核进程树停止、旧写入者退出、已跟踪与未跟踪改动保留、新 Agent 从剩余项续作、重启后状态一致、测试通过。注入的额度事件与真实接入结果均可复跑。 |
| 0.5 | 在 Archon 公开接口上走同一恢复切片，检查调度委托、节点续跑、事件重放和运行状态归属。关键门禁失败时，用独立执行切片复跑失败场景。 | ADR 记录采用路径、放弃理由和升级成本。任一关键能力缺乏证据时，保留为待验证项，继续用本地 PoC 定位缺口。 |

运行记录统一包含环境与版本、输入和故障注入位置、预期与观测结果、事件序列、代码 SHA 或树哈希、退出状态及测试产物。估算投入约 5–8 个工程人日，按单条工程主线计算，账号授权及外部系统等待另计。

## 路线图

| 阶段 | 可交付范围 | 进入下一阶段的门槛 |
| --- | --- | --- |
| Phase 0 · 可行性 | 上游选型、ADR、需求矩阵、可运行 PoC 及运行记录 | 真实 Codex、OpenCode、Magpie 接入有证据，跨 Agent 交接、崩溃恢复和防重复写入通过，架构路径定版。 |
| Phase 1 · 核心 MVP | 单机 CLI、任务队列、Agent 和 Magpie Adapter、额度与预算租约、Worktree、检查点、失败分类和等待恢复。以小型版本化工作流验证计划、开发、测试，再扩展节点种类。在恢复演练中加入[跨 Agent 交接实验](#phase-1-跨-agent-交接实验)。 | 普通任务可降级至允许的资源，关键审查保持能力门槛。并发、所有远程不可用、Worker 或服务重启均有端到端回归。首版 CLI 能提交、查看、暂停、取消和恢复任务。估算 10–15 个工程人日。 |
| Phase 2 · 自主开发闭环 | GitHub App 或最小权限凭据、Issue-to-PR、独立 Review–Fix、CI 失败分流、门禁与人工审批。完成 DAG、条件、并行、循环、子流程、动态任务分解、依赖、重试、定时与 Webhook 等工作流契约。 | 首个真实 mcarplay Issue 形成满足门禁的 Draft PR。验证 P2 修复闭环、CI 同 SHA、事件重复投递、写入应答丢失和越权请求被拦截。估算 12–18 个工程人日。 |
| Phase 3 · 可视化与部署 | Overview、Model Pool、Task Manager、Workflow Manager、PR Review、Evolution。接通真实任务、事件游标、日志、工作流版本和操作权限。补齐多项目配置、初始化、服务自启动、升级迁移、备份和恢复文档。 | CLI 与 Dashboard 显示同一执行状态。验证 Linux、Windows + WSL2 与 macOS 的支持边界，验证备份恢复及 Docker 和非 Docker 部署方式。Evolution 页面展示可用的真实证据，能力进化在 Phase 4 接入。 |
| Phase 4 · 自进化 | 按任务难度、版本和样本量建立能力画像，将知识、Skills、测试、审查规则和工作流改动形成有出处的版本化提案。先回放、再影子评估，并保留回滚。 | 真实历史数据能复现至少一个调度提案和一个知识、审查规则或回归测试提案，记录质量、成本与误报的前后对比。权限、预算、门禁等核心策略的改动经过额外审批。 |
| Phase 5 · 长期自主运行 | 主动维护候选、仓库级预算和并发公平性、插件机制、连续运行。经批准后启用低风险自动合并与多仓库并行。 | 建议完成至少 7 天运行演练和一次备份恢复演练，记录恢复耗时、重复操作、失败原因、预算和人工介入。扩大自动化范围前，复核权限、质量和运行记录。 |

每阶段通过对应的单元、集成、端到端和故障注入测试，关键模块经过独立审查，P0、P1、P2 项清零后推进。Phase 3 及后续周期依据 Phase 2 的实际运行数据重新估算。最终随项目交付安装部署文档、配置示例、架构和 Adapter／工作流／Magpie 开发指南、mcarplay 配置、自动化测试、验收报告和限制清单。

### Phase 1 跨 Agent 交接实验

恢复流程从 Git 检查点接续代码。任务可启用 `--handoff`，在原始提示后附加与当前检查点匹配的笔记。本实验借鉴 CLM 让 Agent 持续整理上下文的做法，验证一份简短交接笔记能否减少 Codex → OpenCode 换手后的重复工作。 [CLI 交接用法](PHASE-1.md#跨-agent-交接笔记) · [CLM 论文](https://arxiv.org/abs/2609.37725) · [交接架构](ARCHITECTURE.md#跨-agent-检查点与进程恢复)

1. **交接内容。** Agent 在运行中记录已完成项、失败尝试、已知阻塞和下一步，测试结果引用实际产物。控制面确认旧进程树停止后，将最新有效笔记关联到任务、尝试和检查点 SHA。任务目标及权限由控制面提供，笔记缺失、无效或与检查点不匹配时，沿用原始提示和 Git 检查点恢复。
2. **对照方法。** 先用本地 fixture 覆盖额度中断、Worker 重启和笔记缺失，再用已授权的模型通道在临时仓库复测。每组从同一检查点创建独立 Worktree，固定接手模型、预算和验收测试。A 组只传原始提示，B 组附加笔记。记录每次复跑的检查点 SHA、模型和结果。
3. **验收标准。** 首先比较任务完成率和测试通过率，再比较重复工具调用、恢复耗时、输入 Token 与缓存读取量。用 Magpie 请求级记录汇总网关估算，并把生成笔记的额外开销计入对照。只有在完成率和测试通过率没有下降、进程停止与写权交接检查通过，并且至少一项效率收益可复现时，才考虑默认启用。 [Phase 1 用量与恢复证据](PHASE-1.md)

首轮使用项目自有的交接格式。完整 CLM 上下文编辑、社区 OpenCode 插件和推理侧 Suffix Cache Reuse 依据实验结果与部署条件另行评估。 [CLM 仓库与许可](https://github.com/facebookresearch/context-language-models)

2026-11-27 在 macOS 完成两组真实模型复测。原生 ChatGPT 当前返回用量上限后，Codex 改经 Magpie 的零标价 `hy4-flash-free` 完成解析器和交接草稿；本地代理在草稿有效后注入 HTTP 429。三次带笔记和三次仅原提示的 OpenCode 接手均 3/3 通过，且只修改 `label.ts`。带笔记组工具调用共 25 次、对照组 28 次；计入笔记生成后，输入 Token 多 519、输出 Token 少 4,899，耗时多 3.16 秒。该结果支持保留显式启用的交接路径，样本量还不足以改变默认策略。服务商账单仍为 `UNKNOWN`。 [真实模型交接证据](evidence/phase1-live-handoff-2026-11-27.json) · [首轮对照证据](evidence/phase1-macos-handoff-experiment-2026-11-27.json)

同日完成默认 Adapter 的 macOS 进程监督闭环。Codex App Server 经受监督 stdio 代理写入 `app.txt=41`，零推理预检的后台子进程在关闭时被回收。OpenCode 默认路径写入 `app.txt=42`，四个 Magpie 请求行完成会话级回写，服务模型为 `hy4-flash-free`，停止凭证均为 `activeProcesses=0`。 [默认 Adapter 证据](evidence/phase1-macos-default-adapters-2026-11-27.json)

Linux 采用 child subreaper 与 `/proc` 进程树枚举，补齐全套停止、取消、stdio 和 detached 后代测试。Bun 官方 Linux 容器中完整测试为 95 通过、1 个 Windows 专用用例跳过；Codex CLI 0.171.0 的零推理 `command/exec` 与后台子进程回收通过。自定义 Codex Server 也必须由独立 verifier 提供停止证明，关闭接口自身不能自证成功；默认 verifier 另经 macOS 真实 Magpie 任务复验。 [Linux 与停止契约证据](evidence/phase1-linux-supervision-2026-11-27.json)

预算租约随后升级为 schema v7。活跃尝试持有预算直到结束，已知或未知的已结束租约到期后只审计一次并保留金额与过期时间。恢复产生的 pending lease 会把到期点写入账户冷却和任务下一次唤醒，预算与冷却等待按各自最早到期时间重新调度。服务商账单归属仍为 `UNKNOWN`。 [预算到期审计证据](evidence/phase1-budget-expiry-audit-2026-11-27.json)

## mcarplay 试点

1. 以[源码初筛的 CI 基线](RESEARCH.md#mcarplay-首个试点)作为起点。开跑前重新核对基线 SHA、默认分支、实际目标分支、受保护分支规则及必需检查。
2. 选择一个已有明确预期和可自动验证回归的真实 Issue，优先考虑诊断工具或可离线验证的 Kotlin 单元测试。锁定测试命令和成功标准，创建任务 Worktree 和幂等的 Draft PR。
3. 运行与仓库匹配的 Python、Gradle 和 GitHub Actions 检查，将 Reviewer 结果与 PR 当前 HEAD 绑定。有车机硬件依赖时保留 `待硬件验证`，模拟器与离线协议回放各自记录覆盖范围。
4. 将模块、Android 构建、兼容性知识与高风险目录规则写入项目配置和知识库。生产发布、正式 APK 签名、合并策略变更按仓库权限与审批规则执行。

2026-11-27 已按上述路径执行 Issue #82。QuotaFlow 在 `mcarplay` `daf67e87` 的隔离 Worktree 中运行 Codex，完成 iAP2 消息目录命名与测试，检查点为 `f39bfdf7025ff48c200beb7f81d8dda172f82d15`。Android 标准测试 1,344 项、remote 测试 25 项、Python 测试 87 项及 lint/APK 构建通过。提交 `abc4c5b` 形成 Draft PR [#141](https://github.com/wangxso/mcarplay/pull/141)，Android CI 与 GitGuardian 均通过。独立 Reviewer、真实车机日志复核和人工合并仍保留为后续门禁。 [mcarplay 试点证据](evidence/phase1-mcarplay-issue-82-2026-11-27.json)

## 主要风险与处理

| 风险 | 处理方式 |
| --- | --- |
| 不同 Agent、账号与网关对额度的观测不一致 | 记录来源、更新时间、窗口单位和授权范围。采用最小可见数据与核销机制，保留 `UNKNOWN`，用配置决定保守等待或允许的低风险回退。 |
| 上游插件接口变动或无法交接写锁 | 固定版本、维护 Adapter 契约测试，Phase 0 对照验证外部进程终止和私有检查点恢复。未达门禁时保留独立实现路径。 |
| 进程被强制终止、Git 和数据库只完成一侧 | 停止并核实旧进程后才移交写锁。用持久化意图、私有 Git 引用和启动对账恢复；验证远端写入重复投递。 |
| 关键 Reviewer 暂不可用或 CI 证据变旧 | PR 保持等待；以实际 HEAD 的审查、测试与必需检查为准。轮数或预算到达上限时进入人工处理。 |
| Issue、日志或构建脚本触发未经授权的操作 | 由受限进程、文件和网络权限及外部操作代理实施边界。测试使用合成输入和无价值凭据标记验证拦截。 |
