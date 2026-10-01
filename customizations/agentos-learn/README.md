# dsh-agentos-learn — AgentOS 自进化接入 DSH

## 职责（宿主半侧薄适配）

1. **任务结束**（`session/event` → `turn/end`）：提取经验候选 → AgentOS `memory-remember` + `learning-evaluate`
2. **任务开始/每轮**（`systemPrompt.section`）：注入「适用经验」（内容只来自记忆库，可审计）
3. **命令**：`/agentos-learn` 状态 · `/agentos-learn-remember` 手记 · `/agentos-learn-recall` 召回

策略在 `lib/learnpolicy.js`（纯函数）；晋升门永远走 AgentOS `learning.mjs`，本插件**不改裁判**。

## 防回退（用户硬约束）

| 风险 | 本插件的对策 |
|---|---|
| factory 抛错 → 连坐 import failed | `apply` 内不抛；事件/hook 全 try/catch；selfcheck 39 项 |
| inject 不存在的服务 → PENDING | 只声明 `systemPrompt` + `commands`（已验证存在） |
| 更新 DSH 后功能丢失 | 源码归档 `customizations/agentos-learn/`，并写入 `preservation.json` |
| 桌面壳/旧 UI 问题复发 | **无 client.js、无 assets、不写 UI**；ui-baseline PASS |
| 想关掉又不想删 | `config.enabled=false` 一键停用 |
| 彻底摘除 | bundles/dependencies 去掉 `dsh-agentos-learn` + 删 `local/dsh-agentos-learn` |

## 一键回退

```powershell
# 1) 停用（不删文件）
# 在 cordis.patch.yml 的条目加 config.enabled: false

# 2) 彻底摘除（活动 Profile）
$profile = 'G:\DSH-3-Portable\Data\DSH-generations\auto-020-rc2\home\profiles\web'
Remove-Item "$profile\node_modules\dsh-agentos-learn" -Force   # Junction
# 再从 package.json 的 dependencies + bundles 删除 "dsh-agentos-learn" 两行
```

## DSH 更新/换代后如何保留

1. 源码在 `customizations/agentos-learn/`（preservation.json 已登记 sha256）
2. 复制到新家园 `Data/DSH-generations/<新代>/home/profiles/web/local/dsh-agentos-learn`
3. 在新家园 `package.json` 加 dependencies（`link:local\dsh-agentos-learn`）+ bundles 条目
4. 建 Junction：`node_modules\dsh-agentos-learn` → `local\dsh-agentos-learn`
5. 跑 `lib/selfcheck.mjs` 与 `scripts/lint-plugin-deps.mjs`

## 自检

```powershell
$node = 'G:\DSH-3-Portable\App\resources\node\node.exe'
& $node local\dsh-agentos-learn\lib\selfcheck.mjs
& $node G:\DSH-3-Portable\scripts\lint-plugin-deps.mjs
```

## 铁律自查

- 命名导出 `name` + `inject` + `apply` ✓
- 注册只经 `ctx`（systemPrompt/commands/effect）✓
- 可调参数走 Schemastery ✓
- 不写 client.js（零客户端 bundle）✓
- 模型可见注入内容来自记忆库（可从 records 重放）✓
- 不伪造验证/回归字段；自动捕获只到 OBSERVATION / EXPERIENCE_CANDIDATE ✓
