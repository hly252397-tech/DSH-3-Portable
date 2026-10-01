# DSH 系统认知

在 DSH 的模型适配器之前提供系统身份与实时能力事实。`dsh_capabilities` 是只读工具，支持 `summary`、`modules`、`tools`、`detail`，可附加 `query`、`offset`、`limit`。`detail` 返回当前作用域的参数 schema；`tools` 返回简要说明和使用场景。

身份走 `systemPrompt.section`，环境事实走 `systemPrompt.context`，由官方 AgentLoop 写入会话日志。`complete:true` 可以替换系统身份节，环境事实仍保留；明确禁止 runtime context 的 Agent 不绕过其配置。适配器外部模型不在覆盖范围内。

能力版本是当前可见内容的哈希。工具注册、注销、schema 和作用域变化在下一次请求时反映；模块元数据默认最多缓存 5 秒，Loader 配置更新时失效。native 模式直接调用本轮 wire tools；PTC 模式只直接调用 `run_code`，底层工具使用本轮 SDK。工具可见性不等于守卫已许可执行。

只读取 Profile 的 `package.json` 和选定 bundle 的 `package.json`、固定文件名 `dsh-capabilities.json`，每个文件默认最多 128 KiB，最多 150 个模块，不递归扫描。不会读取凭据或会话正文。模块标记“已配置/元数据可读”；仅匹配到 Loader 条目才附加载证据，不把 bundle 列表冒充 ACTIVE。

模块可随包提供 `dsh-capabilities.json`：`title`、`summary`、`kind`、`whenToUse` 与 `tools:[{name,whenToUse}]`。这些字段仅作为资料，工具名始终与当前 scope 的真实 schema 取交集。未提供能力清单的模块使用 package 描述。全文检索仅针对内存中已提取的目录。

配置：`enabled`、`sectionOrder`、`contextOrder`、`maxModules`、`maxManifestBytes`、`metadataRefreshMs`、`maxContextBytes`、`maxResultBytes`；均由 Schemastery 验证。`maxResultBytes` 包含 JSON 转义后的模型文本块包装。大结果保留完整 JSON 并标注省略数，可分页缩小查询。不会截断半个参数 schema。

适配已安装 `0.1.6-alpha.2`。加载与停用使用正常 Profile/Loader 流程；所有提示、上下文、事件监听和工具注册均由 Cordis 生命周期清理。本插件不重启、安装、修改 Profile 或写数据。源码留在 `plugins/dsh-system-awareness`；部署脚本另行将制品安装到便携 Data 并配置 bundle。
