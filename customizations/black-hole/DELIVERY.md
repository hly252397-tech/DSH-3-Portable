# 黑洞空间交付与接手

这是 DSH 内部内容模块，不是独立网站。维护源码在本目录；实际安装为 `Data/DSH/profiles/web/local/dsh-black-hole`，用户资料为 `Data/DSH/workbench/black-hole`。三个目录职责不能混淆。

## 当前机器

已通过现有 Web Profile 本地 link 安装并启用 bundle。客户端文件直接由 DSH 加载，不需要重打包桌面可执行程序。当前桌面为 1.0.63，Harness 为 0.1.5-rc.2。端口由启动时分配，不要写死。

在 `G:\DSH-3-Portable` 执行：

```powershell
& .\App\resources\node\node.exe scripts/sync-black-hole.mjs --check
& .\App\resources\node\node.exe node_modules/typescript/bin/tsc
& .\App\resources\node\node.exe --test dist/test/black-hole.test.js
```

日后修改本目录源码后运行 `scripts/sync-black-hole.mjs --install`。脚本校验 Profile 依赖、bundle 与真实链接，仅同步本插件文件；旧文件备份到 artifacts。不会重写 Profile 清单或资料。协作时先检查对方变更，不能拿旧快照覆盖新图标/功能。同步后重载 DSH 页面，按下面的实际操作复验。

## 新机器 / 未安装 Profile

需先安装并启动兼容的 DSH Web Profile 和 better-sidebar。把本包放到该 Profile 的 local/dsh-black-hole，在 Profile 管理中增加本地 `link:local/dsh-black-hole` 依赖和 `dsh.profile.bundles` 中的 `dsh-black-hole`。主机依赖 schemastery 3.18.0。本交付脚本故意拒绝自动重写未知 Profile；不得用本机整个 package.json 覆盖另一机器。

## 人工验收

1. 输入区“黑洞空间”或右卡片 + → 黑洞，实际展开可见面板。
2. 创建测试黑洞，从 0 成长；输入正文、标题留空，保存后检查标题/摘要/标签和来源。
3. 相同正文再次保存，显示重复提示；刷新页面，资料仍存在。
4. UTF-8 TXT/MD/JSON/CSV 先读入草稿，确认后入库；大于 1 MiB / 非文本须拒绝。
5. 打开一段已有会话，“放进黑洞”应有用户与 AI 可见正文，不含思考与工具结果；保存到正确黑洞。
6. 输入框已有草稿时引用，草稿保留并追加资料 ID/正文；不自动发送。清掉仅验收输入。
7. 设置安静，关联提示消失；恢复平衡，相关资料提示能打开对应黑洞。
8. 用两个窗口修改，旧版本保存显示冲突并保留草稿，重试可成功。
9. 检查窄面板、125% 缩放、明暗主题和弹窗按钮可达性。

只有页面/接口/持久化实际操作通过才能称为该项验收通过。Mock 测试不等于独立模型已接入。

## 状态与限制

当前是文本记忆可用版。规则归纳、关键词召回、来源/确认/复用计数可用；独立模型、向量语义检索、知识中心双向展示、PDF/Office/OCR、自动知识融合尚未实现。禁用的模型选项只是数据结构预留。知识成长是游戏分值，非真实智商。

详细开发和本机证据见 `docs/01-当前工作/I026-黑洞空间/01-实机落地.md`。独立模型接入需要另行设计 DSH 服务契约、密钥保护、取消/超时、引用验证和真实模型调用验收，不能仅解除按钮禁用。

## 数据保护与回退

保存使用 revision 冲突检测；每次提交保留上一版 `black-holes.previous.json`。这只是一版备份，不能替代长期备份。恢复必须先停止写入、备份当前 JSON，再校验欲恢复的版本；不要在线直接覆盖文件。

回退插件只恢复本插件源码备份并重新同步，不删除资料目录。不运行 reset/clean，不覆盖其他插件或正在使用的桌面槽。
