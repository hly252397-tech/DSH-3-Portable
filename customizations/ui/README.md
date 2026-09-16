# 已验收 UI 基线

先读 [UI 定制维护契约](../../docs/03-技术架构/UI定制维护契约.md)。

- `baseline.json`：受保护文件路径、SHA256、源码快照路径、修改记录和 UI 证据。
- `sources/`：内容寻址的完整文本快照，包括 Data 中不会随普通 Git 源码保存的定制。不要直接编辑快照；在 baseline.files.path 指向的真实源码处修改，再重建、验证、记录。
- `evidence/`：已验收 UI 的 JSON 快照和三张示意截图；当前首页工作区置底、无框、双卡等高。截图不替代新版本验证。
- 首页最新效果为 `evidence/accepted-home-compact-20260912.png`：双卡默认 120 px、工具栏贴底；较早的 160 px 图保留作历史，不再是当前目标。
- 完整首页最新效果为 `evidence/accepted-home-shortcuts-20260912.png`：标题和四类快捷任务收紧，保留双卡 120 px 和底部工作区条；四类八个预填入口证据随最新 baseline 归档。
- `history/`：每次登记的历史，不覆盖旧记录；当前 baseline 指向最新条目。

项目根执行 `App/resources/node/node.exe scripts/ui-baseline.mjs`。全量测试自动校验；明确通过的修改才允许 `--record --note <项目记录> --evidence <真实QA结果JSON>`。

这些是可入库的本地文件，目前没有因此自动创建 Git 提交或远端备份。恢复单个模块要先备份和比较，不能复制整个旧 Profile 覆盖新版本。
