# 移除 Qoder 工作台主题

## 变更

- 用户要求：移除设置页截图中圈出的“Qoder 工作台”主题（来源：`C:\Users\96551\AppData\Local\Temp\codex-clipboard-5799d3b6-4f0f-48e0-b357-463da1e4975f.png`）。
- 原行为：设置页从 `assets/theme.js` 枚举并显示 Qoder 工作台；主进程默认预设为 `qoder`。
- 新行为：主题列表只保留深海蓝、湖蓝系、塞绿系、朱红靛蓝系、石板春梅系、迪奥金系；默认主题改为深海蓝。
- 兼容处理：历史 `qoder` 持久化值按未知预设处理，安全降级为深海蓝，不删除其他主题配置。

## 对齐关系

- 前端入口：`assets/settings.html` 的主题单选组继续从 `DshThemes.THEMES` 动态渲染，因此删除注册项后不会留下可点击的失效入口。
- 处理与持久化：`assets/theme.js`、`src/desktop-theme.ts`、`src/shell-contract.ts` 同步移除枚举值并更新回退值；无需新增后端接口。
- UI 反馈：当前窗口仍显示已选主题，旧值或损坏值显示深海蓝；其他主题的点击、键盘导航和持久化链路保持不变。

## 本轮验证

- 已更新 `test/desktop-theme.test.ts`、`test/theme-persistence.test.ts`、`test/settings-theme-stability.test.ts`，覆盖默认值、旧值降级、待持久化状态和主题注册表。
- 已执行：使用 `G:\DSH-3-Portable\App\resources\node\node.exe` 完成 TypeScript 编译；主题相关测试 8/8 通过；全量测试 468 项中 454 通过、12 跳过、2 失败。
- 全量测试的 2 项失败均为既有 `customizations/black-hole` UI 基线漂移，与本轮主题文件无关；本轮未接受或覆盖该漂移。便携版实际入口刷新/重启及重新打包尚未执行。
- 未执行打包或活动槽切换；当前记录不宣称已完成真实桌面部署验收。

## 恢复

恢复本轮源码改动即可恢复原枚举；不需要删除 `Data` 中的会话或主题文件。
