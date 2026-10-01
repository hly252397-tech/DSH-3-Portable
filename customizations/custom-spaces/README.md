# 自定义空间插件保留源

2026-09-27：这里包含适配 DSH 0.1.7-rc.2 的完整插件（0.2.0），已在用户允许后部署到活动 v4-rc2b Profile，正常启动与局部界面验证通过；整体门禁尚未通过。宿主 Config 的 volatile spaces 字段由 SettingsForms 描述，客户端通过 configForms.get('custom-spaces') 读写。禁止把旧 installSection/settingsScope 客户端直接启用到 rc.2。

活动 home 为 Data/DSH-generations/v4-rc2b/home；旧 Data/DSH 是冻结家园，不再双写。恢复必须先备份活动 Profile 四文件、确认没有同名有效部署，再保存新包和 link/bundles，并只从 settings.yaml.imported 提取 custom-spaces（目标已有值时不覆盖）。不跑全量 pnpm install，不读取或复制其他设置到日志。

运行 `Tools/node/node.exe scripts/gate-node-run.mjs node_modules/typescript/bin/tsc` 后用 `Tools/node/node.exe scripts/gate-node-run.mjs scripts/run-tests.mjs dist/test/custom-spaces-rc2.test.js` 验证真实 Loader 配置写入、冲突/长度限制及客户端拒绝保存/迟到保存（门禁 Node 必须命中 `package.json` 的 `bundledNodeSha256`，故经转发器；2026-09-29 实测 `Tools/node/node.exe` 已停在 v24.21.0 不命中清单 v26.10.0）。完整桌面真实加载、点击、缩放和两次重载未验证前不能宣称恢复。详见 docs/01-当前工作/20260927-底部空间入口与更新按钮.md。

⚠️ 活动 home 已从 `v4-rc2b` 切到 **`v5-020rc1`**（内核 0.2.0-rc.1，2026-09-29）。本文上方「活动 home 为 v4-rc2b」是当时的记录；动手前先问活动代际：`Tools/node/node.exe -e "import('./scripts/lib/active-ui-profile.mjs').then(m=>console.log(m.activeUiProfile(process.cwd()).profile))"`，**不要照抄 v4-rc2b 路径**。

部署证据位于 `evidence/rc2-20260927/`。实际空间→完整浏览器、顶栏设置→空间配置页、两次独立重载、90%/110% 缩放、窄窗通过；未在用户真实配置上测试保存。活动插件通过 junction 解析当前 runtime slot 的 `@deepseek-ai/schemastery`，换盘符或更换/清理 runtime slot 时必须重新检查并重建该链接；本次不代表跨盘迁移验收。Profile 四文件备份在 `Data/Temp/custom-spaces-activate-20260927/before/`。未重记 UI baseline，不能把局部通过当全量通过。

以下为历史说明，不再要求向冻结家园同步：

此文件与 `Data/DSH/profiles/web/local/dsh-custom-spaces/lib/client.js` 同步，后者经 Profile 的 link 加载。保存于版本化目录，避免修复只存在被忽略的 Data 目录。

2026-09-19 修复 settingsScope 的 this 绑定、alpha.2 snapshot.value 读取和未就绪/不可写保护。验证记录见 I023 的 47 号文档，回归见 `test/custom-spaces-settings-compat.test.ts`。

后续修改必须逐段同步两份源；不可整文件覆盖未审阅的现场改动。UI 基线同时保护两份，真实刷新和设置页验收后才能记录。
