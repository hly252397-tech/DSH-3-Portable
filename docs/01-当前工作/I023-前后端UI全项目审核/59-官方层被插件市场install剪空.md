# 59 - 官方层被插件市场 install 剪空(76 条目 import failed)

**日期**:2026-09-20 晚
**性质**:线上故障 + 恢复记录(不改 src,无候选槽)
**前置**:47 号记录(2026-09-19 启动死页)的同类根因、新触发路径

## 现象

用户报告 web 端 `web boot: 76 entries did not activate`,全部 76 个插件条目(官方 `@deepseek-ai/*` + 社区 `@michengai/*` + 本地插件)报 `import failed (see console for the import error)`。

## 诊断过程(证据链)

1. **实机取证**:`Data/DSH/profiles/web/node_modules/@deepseek-ai/` 目录为 **0 条目**(官方层被剪空);`@michengai`(10 包)与本地插件 Junction 均完好。
2. **归因公共层**:76 条目含文件完好的社区/本地插件,证明不是各插件自身损坏,而是客户端总 runner(`@deepseek-ai/dsh-cordis-client-runner`)等公共层缺失导致整链失败。
3. **时间线**(文件 mtime + 日志):
   - 13:30(本地)最后一次健康 web boot(gateway.log / boot-diagnostics.log);
   - 18:41 `pnpm-lock.yaml` 被改;20:46 `package.json` + `node_modules` 被改;21:30 `node_modules/.pnpm/lock.yaml` 收尾写入。
   - 对比 `package.json.bak-20260919-180809`:期间 `dshmarket` 1.48.0→**1.49.0**、新增本地插件 `dsh-hj-workbench`、移除 `dsh-work-mode`。
4. **根因**:插件市场/插件管理操作触发 profile 侧 `pnpm install`(hoisted)。官方层(197 包)自 09-19 修复起**不在 dependencies**(strip 护栏依赖"manifest 无官方包"形态),pnpm install 按 manifest+lock 解析树剪枝 → 官方层全家被删 → web boot 全量 import failed。**strip 护栏本身无责**(dependencies 干净,build.8 的 strip 是 no-op)。
5. **伴生根因**:`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 豁免清单停在 `dshmarket@1.40.0 || 1.48.0`,1.49.0(当日新发)落在发布龄政策外,与 09-19 事故第二重根因同构。

## 修复(照 47 号⑥已验证流程)

1. 备份三件套:`package.json.bak-20260920-restore`、`pnpm-lock.yaml.bak-20260920-restore`、`pnpm-workspace.yaml.bak-20260920-restore`。
2. 豁免清单补 `dshmarket@1.49.0`(`pnpm-workspace.yaml` 第 19 行)。
3. 离线重装官方层:`App/resources/node/pnpm.cmd add --prefer-offline --store-dir G:/DSH-3-Portable/Data/Development/pnpm-home/store "@deepseek-ai/dsh-base@0.1.6-alpha.2" "@deepseek-ai/dsh-web-app@0.1.6-alpha.2"` → **57.1 秒,reused 395 / downloaded 0,added 396**(全本地 store 复用,零网络)。
   - 注意:必须带 `--store-dir` 指向 `Data/Development/pnpm-home/store`(pnpm 自动拼 `v11`),否则 `ERR_PNPM_UNEXPECTED_STORE`。
4. 从 dependencies 摘掉两条官方条目(恢复"manifest 无官方包"语义);`pnpm add` 本次仅新增这两行、未触碰 link 路径与 bundles 字段。

## 验收证据

- `@deepseek-ai` 下 **197 包**(与 47 号"官方层 197 包完好"口径一致);
- `pnpm install --frozen-lockfile --lockfile-only` → **Already up to date**(主 lock 与 manifest 一致);
- 定向测试 `sidebar-service-lifecycle` + `plugin-seed` **45/45 全绿**(运行器自动清理临时目录);
- host 端 21:36 热重载成功:`boot-diagnostics.log` 13:36:21 / 13:36:26(UTC)两条 `apply ok; timer=true; schedule=true`(P3 Tiny 活体探针);
- 界面截图(21:41,vision 识别):正常渲染,有侧边栏与任务区,**无加载屏/白屏/错误横幅**;
- gateway 控制端口(62586)1.8ms 响应(401 需认证,属预期)。

## 遗留与结构性隐患(未在本轮处理)

1. **结构性死结未解**:官方层不在 dependencies ⇒ 任何一次 profile 侧 `pnpm install`(插件市场升级/安装插件)都会再次剪空官方层,故障必然复发。本轮只是恢复。候选根治方向(需单独迭代评估):
   - 插件管理器在 install 后自动补装官方层(检测 `@deepseek-ai` 缺失即 `pnpm add --prefer-offline` 伞包再摘条目);
   - 或把官方层固化为 profile workspace 的隐藏包,让解析树始终包含它。
2. `ensurePnpm11BuildPolicy` 豁免清单动态合并(随包版本自动豁免)——09-19 已列为改进,本轮又手动补了一次 `dshmarket@1.49.0`,同一坑第三次踩中。
3. `gateway.log`(im-connect)在热重载路径不写 boot 日志,只有完整 boot 才写——热重载健康度只能靠 `boot-diagnostics.log` 探针,排查时勿误判。

## 复盘口径

- 诊断行(动手前):问题是 76 条目全量 import failed;证据是 `@deepseek-ai` 0 条目 + 时间线指向 pnpm install;下一步是补豁免 + 离线重装。
- 无对照复现环节(故障为破坏性删包,恢复即消灭现场;旧态以 47 号记录 + 三件备份为凭)。
