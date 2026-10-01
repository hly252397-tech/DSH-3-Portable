# 60 - 客户端 bundle 自调度重启(无限重启事故)

**日期**:2026-09-21
**性质**:线上故障 + 恢复记录(不改 src;改 profile 本地插件客户端 bundle,Junction 直写生效)
**前置**:47 号(启动死页)、59 号(官方层剪空)同类"看起来像环境坏了"的故障

## 现象

用户报告「解决不停的重启问题」并附截图:窗口停在启动页(鲸鱼粒子 + 90% 进度圈 +「正在启动 DSH 服务…」)。

实测:桌面进程每 **80–130 秒**被重启一次;`Data/Updates/Desktop/launcher.log` 周期性出现接管行;而 host 每轮都 boot 成功(`Data/DSH/dsh-im-connect/gateway.log` `apply 完成`,boot 计数 736→739 持续增长)。截图"卡 90%"其实是循环的启动相位——单轮 ~90 秒里启动占 ~60 秒,随机时刻看窗口大概率看到启动页。

## 关键鉴别证据(为什么不是 host 崩)

1. `launcher.log` 的 **`启动器接管握手已就绪：等待旧桌面主进程 X。`** 只在**应用自己请求重启**时写出(`src/main.ts` `spawnPortableLauncherForRestart` 先写握手文件)→ 循环的发起方是客户端,不是 host 崩溃。
2. `Data/Updates/Desktop/restart-handoff.log` 最近无新条目 → 每次握手都成功,不是交接超时重试。
3. 时间戳对齐:**probe 写盘 13:17:48 → 握手 13:17:49**(相隔 1 秒),即"第二次 probe POST 后立刻 app-restart"。前几轮同构:13:15:41→13:15:42。

## 根因

`Data/DSH/profiles/web/local/dsh-hj-workbench/lib/client.js`(258–288 行)残留一段**无门控**的临时自动重启:

```
页面加载 → +2.5s → POST /ui-tweaks/probe → 睡 30s → 再 POST → window.dshDesktopShell.action('app-restart')
```

- 顶部注释声称"只在构建完成、回收区排空后由我 bump reload-token 触发",但**代码里没有任何门控**(无 token 判断、无一次性标记、无环境判断)。
- **客户端 bundle 每次页面加载都会执行** → 重启后页面又加载 → 又重启 → **自激循环**;周期 = host 启动(~60s)+32.5s ≈ 90s,与实测吻合。
- 它自己的取证留在 `local/dsh-ui-tweaks/lib/ui-probe.json`:`{"diag":"hj-auto-restart","hasAction":"function"}`(`hasAction:"function"` 证明 action 可用、重启必然触发)。

## 排除项

| 候选 | 排除依据 |
|---|---|
| `dsh-restart-button` 宿主端点 | 需配置 `agentToken`,默认空 ⇒ 403 停用;无任何调用方 |
| `dsh-p3-tiny-watch` | 只用 `process.send({type:'notify'})` 发通知,不发重启 |
| `recycleDshForPluginUpdate`(插件更新后 host 回收) | 进程内回收,不产生启动器握手日志行 |
| `watchProfileActivation` | 只对 `package.json` / `node_modules` / `.dsh-reload-request` 反应 |
| 外部计划任务 | 全仓库只有 `src/main.ts:727` 一处 spawn 启动器 |

## 修复

删除该 block(profile 本地插件是 Junction,改盘即生效;下一次页面加载读到新 bundle 后循环终止)。

- 全量 grep `hj-auto-restart|app-restart` 命中 `local/*/lib/*.js` 仅此一处(另一处是 `dsh-restart-button/lib/index.js` 宿主半侧,属合规形态)。
- 语法校验:`node --check`(复制为 `.mjs`)通过。
- 无需构建、无需候选槽(改的是 `Data/` 运行数据,不进 `app.asar`)。

## 验收证据

- **修复前**:13:09:34 → 13:11:21 → 13:12:39 → 13:15:42 → 13:17:49 → 13:19:15 连续握手;
- **修复后**:13:19:15 起 200 秒采样窗 + 复检共 **5.5 分钟内握手计数恒为 257**,桌面进程 PID 36360 自 13:19:26 持续存活(此前最长存活 ~130 秒);
- 窗口截图 13:24:主界面完整(侧栏 / 会话正文 / 文件面板 / 输入框),非启动页;
- ui-tweaks 布局探针最后一次写盘为自身诊断载荷,`errTexts: []` 且列出全部官方+社区 client bundle ⇒ 插件加载健康;
- 护栏用例 `test/no-self-scheduled-restart.test.ts` **1/1 通过**(tsc exit 0);**正对照**:把事故原文喂给护栏的同款正则命中 2 条规则、修复后文件 0 命中(证明护栏真能抓到、不误报);
- 铁律已固化到 `AGENTS.md` 第 150 行。

## 伴生观察(本轮未处理)

1. **profile `node_modules/@deepseek-ai` 仍为空(0 包)**,但**本轮不构成故障**:host 实际是从**运行时槽**解析官方层——实测 host cmdline 为
   `...\Data\Runtime\Harness\slots\0.1.6-alpha.2-cf1f0a33455401b5\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 0 --no-open`,
   该槽 `@deepseek-ai` = 260 包。这**修正了 59 号推论的边界**:profile 侧官方层剪空 ≠ 必然 76 条目 import failed,**只有运行时槽也缺层才会全量失败**;59 号当时的差异点需另查。
   本轮**刻意不做任何 install**——在健康状态下对 G: 盘跑 4.4 万文件级物化是自找风险(见 47/59 号)。
2. 启动期桌面更新检查持续 `CHECK_FAILED`(「无法连接桌面更新服务」),与循环无关,属独立噪声。
