---
name: dsh-dev-spec
description: DSH 便携版 3 仓库的强制开发流程。凡在此仓库开发功能、修复缺陷，或改动 src/、Data/DSH/profiles/**、App/resources/**、cordis.patch.yml、打包与启动脚本之前加载：双基线核对→必读文档→审查清单→类型/测试门禁→A/B 候选打包→端到端验证。也用于社区插件（MichengAI 等 rc.1 插件）移植前的 API 兼容核对与排障。
---

# DSH 开发规范流程（dsh-dev-spec）

把 AGENTS.md 的强制流程固化为可执行步骤。AGENTS.md 是规则源，本技能只管流程与命令；两者冲突时以 AGENTS.md 和 `docs/03-技术架构/` 为准。

## 1. 动手前

1. 双基线核对：

   ```sh
   ./App/resources/node/node.exe scripts/verify-dsh-official-baseline.mjs --online
   ```

   离线或核对发现官方有变：只能继续诊断，不得宣称「符合官方最新要求」，先人工审阅官方变化。**PASS = 官方 HEAD 与基线一致，规范仍最新**（2026-09-07 已验证官方 quickstart/develop-basic/reference 与规范知识库零冲突）。

2. 按序读完（都在仓库内）：

   - `docs/00-交接入口/07-功能清单.md` —— **全部已实现功能清单（73 项/13 类），动手前通读**：要做的功能若已存在，照既有形状改、不另起炉灶（「扩展页」返工的教训）
   - `docs/03-技术架构/DeepSeek-Harness-官方兼容基线.md`
   - `docs/03-技术架构/DeepSeek-Harness-插件开发规范知识库.md`
   - 涉及社区插件移植/排障 → `docs/03-技术架构/DeepSeek-Harness-社区插件rc1-alpha3兼容对照.md`
   - 受影响子系统的一手资料（内置 `.d.ts` / 官方 Reference），不得用本地摘要代替

3. 对照 AGENTS.md「审查动作」清单逐条自问；行为归属拿不准先查知识库第 10 节归属表（含社区实证补充的 3 行）。

4. 只改任务点名的范围；顺手发现的问题报告给用户，不代改。

## 2. 类型与测试门禁（改动后，必须全绿才算完成）

```sh
./App/resources/node/node.exe node_modules/typescript/bin/tsc
./App/resources/node/node.exe --test dist/test/*.test.js   # 0 fail
```

禁止用系统 Node（版本门禁，以 package.json 的 bundledNodeVersion 为准）。

## 3. 打包与部署（src/ 改动需要）

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File Build-DSH-Portable.ps1
```

- 完成 类型检查→测试→打包→候选暂存；不覆盖在用的 `App/`，不结束桌面进程。
- 打包完成后主动通知用户「可以重启了」；候选由下次启动经 `Start-DSH-Portable.ps1` 切换、验证健康文件、失败自动回滚。
- 禁止原地覆盖 `App/`，禁止恢复已删除的原地覆盖部署脚本。

## 4. 端到端验证与功能登记

双击 `DSH便携版3.exe` 启动，确认：候选通过清单哈希、主界面与 DSH readiness 正常、`Data/Updates/Desktop/state.json` 进入 `completed`、`Data/Electron/UserData/startup-error.log` 无新增错误。

**新增了功能 → 必须在 `docs/00-交接入口/07-功能清单.md` 对应分类登记条目（编号/名称/文件/状态/描述）并更新变更记录；修复既有功能 → 更新对应条目状态。**

## 5. 排障工具箱（实测踩坑，别再交一遍学费）

- **搜运行时必须用 bash grep**：ripgrep/Grep 工具按 `.gitignore` 跳过 `App/`，会「搜不到」；搜 `App/dsh-runtime` 用 `grep -r`。
- **运行时真身在嵌套层**：`App/dsh-runtime/node_modules/@deepseek-ai/` 顶层只有 5 个壳包，实际包和 6931 个 `.d.ts` 在 `dsh/node_modules/@deepseek-ai/` 下。
- **核对某 API 是否存在于 alpha.3**：

  ```sh
  RT="App/dsh-runtime/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
  grep -rn "  <服务名或方法名>:" "$RT" --include="*.d.ts" | head -3
  ```

- **bash 工作目录跨命令保持**：长命令链开头显式 `cd /g/DSH-3-Portable`，否则相对路径静默落空、命令「成功」但查了空气。
- 本机 profile 实装的社区插件状态与证据见对照表 §5；两个 ⚠️ 项（subagents `'fork'` provider id、betterSidebar 为第三方包）先写最小探针在真实 Profile 上跑，再写业务代码。

## 6. 生态插件装前核对（装/移植任何第三方插件前）

1. **找插件只认 `awesome-dsh-plugin` 目录**（`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，180+ 分类清单）；GitHub topic 页噪音大（非插件项目也打标），不作索引。
2. **三查**：
   - 有 `dsh.bundle` 清单——没有则只是普通依赖，不激活 patch 层；
   - README 的版本标注与官方基线对得上——官方并无 `rc.6` 之类版本，可疑标注（实例：dsh-routing-suite 自称 `>=0.1.0-rc.6`）先按双基线核再装；
   - 装完 `startup-error.log` 为空、DSH readiness 正常。
3. **归因纪律**：`dsh-better-sidebar`（omdsh-dev 工作台家族）、`dsh-desktop`（anywhere-labs 原生桌面壳）等是第三方生态件，不是官方能力；出问题先查插件自身与兼容对照表，不往官方基线上归因。
