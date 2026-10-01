# 已退役：独立自动化工作台

2026-09-12 用户要求只保留左侧“定时任务”。`build.mjs`保留旧调用接口，但现在只验证/还原原生AutomationView，不再注入`workbench.js`、底部Launcher或设置中转页。旧`workbench.js`只用于历史排查，禁止重新挂载。原调度runtime、计划和执行记录保持。

应用迁移：项目根运行 `App/resources/node/node.exe scripts/restore-scheduled-tasks-entry.mjs`，它复用本目录的钉版校验并备份当前客户端。上游版本不匹配必须先复查设置组件和入口，禁止直接改哈希。流程、实际证据与回滚范围见`docs/01-当前工作/I023-前后端UI全项目审核/31-定时任务与源码入口收敛.md`。
