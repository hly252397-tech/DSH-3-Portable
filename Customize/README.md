# 便携定制层

- `App-Overlay/`：官网更新完成后，其中的文件会按相对路径覆盖到新的 `App/`。适合放不会与新版结构冲突的图标、配置或外置资源。
- `After-Update.ps1`：可选的高级更新钩子。更新脚本会传入 `-PortableRoot`、`-AppDirectory` 和 `-Version`。钩子失败时会停止更新流程并保留旧版备份。
- 源码级定制请在 Git 分支中提交，再运行 `Build-DSH-Portable.cmd`。不要直接修改 `App/resources/app.asar`；官网更新会替换它。

`Data/` 永远不作为覆盖层，它保存会话、配置、凭据、缓存和运行时，更新脚本不会复制或清空它。
