# MCP 0.2.58 / 0.2.59 刷新性能兼容

`connection-scopes-0.2.58.mjs` 与 `governance-0.2.58.mjs` 是修改前社区包源码快照，仅供对照测试；不是运行时替代包。

维护源码为 `scripts/patch-mcp-scope-refresh.mts`。它只接受已审阅的 dsh-mcp-connector 0.2.58 / 0.2.59 和精确代码锚点；默认只检查，`--install` 才备份并安装。后续插件升级需重新审阅，不能强制套用。

2026-09-27：从 npm 官方 registry 下载 0.2.59，核对 tarball SHA512 integrity 后解包。两个目标文件与这里的 0.2.58 快照逐字节一致，因此复用原始快照，不伪造新源码。connection-scopes.js SHA256 为 `e5b33e0f09176276a8a50dfe4785c799de53aeecaabd866141efce723e57f089`，governance.js 为 `c25a939a73467291dbcc314bcc0c5adc91a10b91645bc9a7aeb8f478e4a1d88d`。原有锚点唯一性、幂等性及权限行为测试不减免。此记录不表示已修改活动 Profile。

```powershell
# 门禁 Node 必须命中 package.json 的 bundledNodeSha256，故经 gate-node-run.mjs 转发
# （2026-09-29 实测：Tools\node\node.exe 已停在 v24.21.0 不命中清单 v26.10.0）
& ./Tools/node/node.exe scripts/gate-node-run.mjs node_modules/typescript/bin/tsc
# 安装目标必须用「活动代际」，不能钉死 v4-rc2b：活动内核已是 0.2.0-rc.1、家园 v5-020rc1，
# 钉死旧代会改到回滚代里去（改了也不生效）。先问活动 Profile：
& ./Tools/node/node.exe -e "import('./scripts/lib/active-ui-profile.mjs').then(m=>console.log(m.activeUiProfile(process.cwd()).profile))"
& ./Tools/node/node.exe scripts/gate-node-run.mjs dist/scripts/patch-mcp-scope-refresh.mjs <上一步输出的 profile>/node_modules/dsh-mcp-connector --install
& ./Tools/node/node.exe scripts/gate-node-run.mjs scripts/run-tests.mjs dist/test/mcp-scope-refresh.test.js
```

行为：每轮作用域刷新只生成一次全局名称快照；所有连接均为全局时无需做作用域拒绝，零规则且无停用连接时无需做治理拒绝，因此这两条明确无拒绝项的路径不展开工具 schema。原有 guard、项目限制、停用与 deny 规则保持；转回全局/无规则时清除旧限制。没有跨轮缓存或延迟权限生效。

恢复时正常退出 DSH，把两个 `lib/*.js.before-refresh-snapshot-20260927` 备份复制回对应 `.js` 后重启。安装于可变社区 Profile 包，不改官方运行时或桌面槽。

完整证据、失败尝试与边界见 `docs/01-当前工作/20260927-点击与缩放失效-搬运监听循环.md`。
