# AGENTS.md — 智能体强制开发指令（DSH 便携版 3）

本仓库是 **DeepSeek Harness (DSH) 官方应用**的便携版定制（内置 `@deepseek-ai/dsh` 0.1.2-alpha.3 运行时）。
DSH 是插件化架构：**产品一切部分皆插件，一切注册可逆**。定制功能前必须理解并遵守官方插件规范。

## ⛔ 强制流程：任何功能增加或缺陷修复之前

**凡涉及以下范围的改动，必须先通读规范知识库并逐条对照审查：**

- `src/`（Electron 主进程 / 桥接层）、`browser-library.cjs`
- `Data/DSH/profiles/**` 下的插件（如 `dsh-sidebar-spaces`）、`cordis.patch.yml`
- `App/resources/**` 运行时装配产物、`scripts/prepare-runtime.ts`、打包与启动脚本
- `package.json`（版本、bundledNodeVersion、extraResources）

**必读文档（按序）：**

1. `docs/03-技术架构/DeepSeek-Harness-插件开发规范知识库.md` —— 完整规范知识库（本仓库整理，含全部接口代码与铁律）
2. 官方文档（需要最新细节时）：<https://deepseek-harness.github.io/deepseek-harness/>（develop/basic → framework → practice → reference）

**审查动作（写代码前逐条自问）：**

- [ ] 我的新行为归属正确吗？对照知识库第 10 节"新行为归属表"（工具→`ctx.tools`、提供方→`ctx.llm`、拦截→事件、命令→`ctx.commands`、后台任务→`ctx.jobs`）
- [ ] 是否触碰"模型可见输入"？是 → 必须新增会话事件（扩展 `SessionEventMap`），铁律 1"模型可见即已记录"
- [ ] 插件导出是否符合三种合法形态之一（`name` + `inject` + `apply`）？
- [ ] 所有注册是否经由 `ctx`（自动清理）？有没有违规的手动 `removeListener`/`clearInterval`？
- [ ] waterfall 监听器是否都调用了 `next()`？
- [ ] 可调参数是否都做成了 Schemastery 配置而非硬编码？
- [ ] 本地插件路径是否绝对路径？patch 条目是否带稳定 `id`？
- [ ] patch 覆盖是否重述了整行配置（后层按行胜出，非深合并）？

## ✅ 强制验证：改动完成之后

1. **类型与测试门禁**（必须全绿才算完成）：

   ```sh
   ./App/resources/node/node.exe node_modules/typescript/bin/tsc
   ./App/resources/node/node.exe --test dist/test/*.test.js   # 当前 247 项，0 fail
   ```

   注意：使用 `App/resources/node/node.exe`（v24.20.0），禁止用系统 Node（版本门禁）。

2. **重新打包 + 原子部署**（src 改动需要）：

   ```sh
   # 打包（TEMP 需指向用户目录，否则 NSIS 失败）
   cmd /c "set TEMP=C:\Users\96551\AppData\Local\Temp&& set TMP=C:\Users\96551\AppData\Local\Temp&& set CSC_IDENTITY_AUTO_DISCOVERY=false&& .\App\resources\node\node.exe node_modules\electron-builder\cli.js --win dir --publish never"
   # 确认 DSH Codex Desktop 进程已退出后：
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy-new-build.ps1
   ```

3. **端到端验证**：双击 `DSH便携版3.exe` 启动，确认主界面加载、无 `Data/Electron/UserData/startup-error.log` 新增错误。

## ⚠️ 本仓库已踩过的坑（不要再犯）

- **GNU tar / bsdtar 差异**：`runtime-archive.ts` 必须运行时探测（GNU 才加 `--force-local`）。测试环境（Git Bash）解析到 GNU tar，用户双击启动器环境解析到 System32 bsdtar —— **测试通过 ≠ 用户可用，必须用双击启动器路径验证**
- **ps1 脚本必须带 UTF-8 BOM**：PowerShell 5.1 按 ANSI 解析无 BOM 的 UTF-8，中文注释会导致语法错误
- **插件 `lib/` 结构**：`dsh-sidebar-spaces` 的 `node_modules` 实例曾因缺 `lib/index.js` 崩溃（ERR_MODULE_NOT_FOUND）；修复物在 `local/dsh-sidebar-spaces`，不要破坏
- **部署中断 = App 残缺**：部署/更新流程被打断会留下没有主 exe 的 App 目录；恢复方式 = 重跑 `deploy-new-build.ps1`
- **electron-builder TEMP**：必须显式指向用户临时目录（见上），否则 NSIS 找不到临时 include 文件
- **PowerShell 转义**：Git Bash 里调用含 `$_` 的 PowerShell 命令会被 Bash 展开，用单引号包裹或写成 ps1 文件

## 📁 关键文档

| 文档 | 用途 |
|---|---|
| `docs/03-技术架构/DeepSeek-Harness-插件开发规范知识库.md` | **插件/接口/事件/打包规范（改动前必读）** |
| `docs/03-技术架构/00-桌面启动器架构基线.md` | 桌面启动器架构 |
| `docs/03-技术架构/DeepSeek-Harness-企业级自动更新方案.md` | 更新机制设计 |
| `docs/01-当前工作/便携版3-变更与答复质量门禁.md` | 变更质量门禁 |
| `便携版3-使用说明.md` | 用户视角使用说明 |
