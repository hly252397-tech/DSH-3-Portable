# 45 · better-sidebar 生成 bundle 字符损坏 → 46 插件连坐启动失败（2026-09-17）

## 症状

用户真机重启后 HARNESS「Failed to load plugins」：49 entries did not activate
（46 条 `import failed` + 3 条 pending 等 `sessions` 服务）。此前同日已修过
ui-tweaks 语法错误（§11）与 agentos-trigger 形状错误（§13），两者均不在本次失败名单——
但更换根因后现象雷同，极难分辨。

## 根因（实测链）

`Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js`（2026-09-17 16:01 生成，
1,350,555 字节）被**全域字符替换损坏：每个 `m` 变 `i`**——

- `name`→`naie` ×248、`document`→`docuient` ×107、`element`→`eleient` ×23、
  `scheme`→`scheie` ×63、`custom`→`custoi` ×90、`platform`/`program` 若干；
- 对外契约全坏：`require("react-dom")`→`react-doi`、`react-dom/client`→`react-doi/client`、
  `react/jsx-runtime`→`react/jsx-runtiie`、`@deepseek-ai/dsh-client-ui-primitives`→`priiitives`。

因替换自洽，**语法合法**（过 `node --check`）、**factory 形状合法**（vm 沙箱 stub require 放行），
只在真实浏览器 materialize 时抛错，并把同一启动批次里 46 个未激活条目全部拖成
`import failed`（含全部官方 client-ui 模块——连坐，非各自损坏）。

### 定位过程要点（防复用踩坑）

- 客户端 bundle 服务读 **`$DSH_HOME/profiles/web`**，不是 `DSH_PROFILE_DIR`
  ——改 DSH_PROFILE_DIR 指向副本做二分**无效**（服务路径没变）。正确隔离法：
  空 HOME + `HOME/profiles/web` 联接到待测树（本轮 rig）。
- `transferSize=0` 的 performance 条目是缓存伪影；三段 combo 逐段解析 / vm 顺序求值均无异常——
  唯一可靠证据是**加/减 better-sidebar 的对照**：在场 48 失败，离场 0 失败。

## 处置

1. **禁用**：live `package.json` 移除 `dsh-better-sidebar` 依赖与 bundle 条目
   （备份 `package.json.bak-before-sidebar-disable-20260917`）。损坏文件保留原地不动
   （取证副本在 `Data/Development/better-sidebar-mangled-20260917/`），待属主会话从源重建后再启用。
2. **rig 验证**：副本含其余全部在场增量（ui-tweaks 16:06、sidebar-spaces 15:30、
   agentos-trigger 修复版）、仅缺 better-sidebar → **0 失败，应用正常挂载**。
3. **门禁固化**：`lint-ui-discipline.mjs` 新增检查⑧——服务清单内本地 bundle 的
   `require("…")` 规格必须命中「官方/社区包出现过的规格 ∪ bundle id ∪ 相对路径」集合。
   对照组：损坏 bundle 被精确命中 4 个未知规格。lint 现 11/11。
4. `tsc` exit 0；全量测试除基线守卫（要求重记）外全绿，随本记录重记基线。

## 未验证边界

- 真机需重启一次载入禁用后的清单（客户端字节在 harness 进程启动时快照）。
- better-sidebar 功能（侧栏布局/标签页）随禁用暂不可用，直至属主会话重建健康 client.js。
- `client-registry.js`（同批 16:01）经查**未损坏**，重建时源侧可参考。
