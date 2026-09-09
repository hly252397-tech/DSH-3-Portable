# 便携定制

统一 A/B 更新器不会把旧版本文件覆盖到新候选槽，也不会执行任意更新后钩子；这样可确保 GitHub Release 摘要、槽清单和实际运行文件一致。

- 源码级定制请提交到自己的 Git 分支，再运行 `Build-DSH-Portable.cmd` 构建并验证。
- `App-Overlay/` 仅保留为历史定制素材库，不会自动写入已验证的应用槽。
- 不要直接修改 `App/resources/app.asar` 或 `Data/Updates/Desktop/slots/`，否则完整性门禁会拒绝启动候选并自动回滚。
- `Data/` 保存会话、配置、凭据、缓存和运行时，桌面应用更新不会复制、清空或迁出它。
