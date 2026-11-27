# 上游许可证与依赖面审查

**基线日期** 2026-11-27

**源码版本** 与 [RESEARCH.md](RESEARCH.md) 中的固定提交一致。

**建议范围** 只通过公开协议调用独立工具；QuotaFlow 不复制上游源文件，也不随包分发上游 CLI、模型或其依赖。按此边界，当前固定树审查未发现需要将上游代码纳入 QuotaFlow 的理由；这不代表 Phase 1 已获准。若决定嵌入、修改、镜像或分发任一工具，必须先完成该制品的依赖 SBOM 和许可证义务复核。

本表检查了每个固定源码树的根许可证、可见的额外 `LICENSE`／`NOTICE` 文件以及依赖清单和锁文件。它没有逐一为锁文件中的所有传递依赖做 SPDX 扫描，也没有量化候选项目间的升级与维护成本；当前不复制或分发这些制品，因此完整扫描应绑定到未来实际选用和交付的制品，不能用仓库根许可证替代。当前原型的维护假设是锁定外部工具版本、维护适配器契约测试，更新版本前重跑阶段验证。

| 候选 | 固定提交的许可证与额外声明 | 依赖面 | QuotaFlow 建议用法 |
| --- | --- | --- | --- |
| Archon | 根目录 MIT；固定树未发现根级或包级 `NOTICE`。 | Bun workspace，根 `bun.lock`、`auth-service/bun.lock` 和多个 workspace `package.json`。 | 仅作为外部 CLI/工作流参考；当前不复用源码。若打包其二进制，先生成完整依赖清单并保留 MIT 与依赖声明。 |
| Magpie | 根目录 MIT；`internal/qoder/LICENSE` 为 MIT；`third_party/jsonschema/LICENSE` 为 Apache-2.0；`third_party/yaml.v3/LICENSE` 明确为 MIT 与 Apache-2.0 双许可，并附 Canonical 的 `NOTICE`。 | Go `go.mod`／`go.sum`，并有 vendored 子项目和独立许可证。 | 作为独立可选网关调用，不复制或打包其实现。若分发 Magpie，必须合并根、vendored 子项目及 Go 依赖的许可证/NOTICE。 |
| Symphony | Apache-2.0，另有根 `NOTICE`。 | Elixir `mix.exs`／`mix.lock`。 | 仅参考其工作区和恢复设计；若复制或分发，保留 Apache 许可证、NOTICE，并标明修改过的文件。 |
| Ralph Workflow | AGPL-3.0-or-later；根与 Python 包目录都有 `LICENSE`。 | Python `pyproject.toml`／`uv.lock`。 | 不作为 QuotaFlow 的库、内嵌服务或源码基底；只保留架构层面的参考。任何直接复用前重新审查 AGPL 适用义务。 |
| Hats / Ralph Orchestrator | MIT；另有说明性 `docs/license.md`。 | Rust `Cargo.lock`，并含 npm 与 Python 子项目锁文件。 | 仅参考事件与角色注册实现；不纳入运行时依赖。 |
| MetaSwarm | MIT；固定树未发现额外 `NOTICE`。 | 根 `package.json`；该固定树未发现 npm 锁文件，另依赖外部 Agent CLI 和可选工具。 | 仅参考工作流，不复制其安装器写入项目的模板或技能。若以后复制资源，逐项记录来源和各自许可证。 |
| OpenCode | 根目录 MIT；另有 `http-recorder`、`process-daemon`、UI 和 Ghostty 子目录许可证，以及 Figma 技能材料 `NOTICE.md`。 | 根 `bun.lock`、多个 Cargo 锁文件和多包 `package.json`。 | 作为用户单独安装的 Agent CLI；不把可执行文件或资源打入 QuotaFlow。若分发，需按实际发布制品收齐所有子包和 vendored 依赖声明。 |
| AgentBridge | MIT；固定树未发现额外 `NOTICE`。 | npm `package.json`／`package-lock.json`。 | 当前只作 Adapter 契约参考，不引入其包。 |
| Beads | 根 MIT；`integrations/beads-mcp/LICENSE`、`npm-package/LICENSE` 和 `third_party/bdp/spec/LICENSE` 也分别存在。 | Go `go.mod`／`go.sum`，另有 Python `uv.lock` 与 npm 子包。 | 作为外部任务工具的参考，不嵌入 QuotaFlow；若打包子项目，保留对应许可证并补齐各自依赖清单。 |

## 当前制品边界

- `poc/` 是本项目编写的试验代码，通过 HTTP、命令行及 Git 调用候选工具；没有从上述仓库复制源文件。
- 下载到 `work/` 的 Archon、Magpie、OpenCode、llama.cpp 二进制和 Qwen GGUF 权重未纳入 QuotaFlow 仓库或交付包。Qwen 权重的来源及许可证尚未记录；任何模型权重分发前必须单独核实上游模型卡与许可。
- Phase 1 应继续采用“用户安装外部 Agent／网关，QuotaFlow 仅负责适配”的原型边界。若打包或自动下载任何候选，先对实际下载版本做 SBOM、许可证文件和 NOTICE 复核。

## 固定源码入口

各项目根许可证和依赖文件链接见[上游源码初筛](RESEARCH.md#候选基线)。本次核对的额外文件按固定提交查看：

- [Magpie vendored qoder MIT](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/internal/qoder/LICENSE)、[jsonschema Apache-2.0](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/third_party/jsonschema/LICENSE)、[yaml.v3 双许可](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/third_party/yaml.v3/LICENSE) 与 [yaml.v3 NOTICE](https://github.com/yetone/magpie/blob/f88664839c298e7a372dc1f86b9140a995c854a5/third_party/yaml.v3/NOTICE)。
- [Symphony NOTICE](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/NOTICE)。
- [OpenCode HTTP recorder](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/packages/http-recorder/LICENSE)、[process daemon](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/packages/process-daemon/LICENSE)、[Ghostty](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/packages/process-daemon/src/ghostty/LICENSE) 与 [Figma 技能声明](https://github.com/anomalyco/opencode/blob/3161ddcbfbeff005f7dfd7342d2fb97dba9b72e2/packages/plugins/figma/skills/NOTICE.md)。
- [Beads MCP 集成](https://github.com/gastownhall/beads/blob/708992f78476c3dc5d11a44a3b273accd5e3c70c/integrations/beads-mcp/LICENSE)、[npm 子包](https://github.com/gastownhall/beads/blob/708992f78476c3dc5d11a44a3b273accd5e3c70c/npm-package/LICENSE) 与 [第三方规范](https://github.com/gastownhall/beads/blob/708992f78476c3dc5d11a44a3b273accd5e3c70c/third_party/bdp/spec/LICENSE)。

这是一份工程选型记录，不替代发行前的法律审查、完整依赖许可证扫描或候选维护成本评估。
