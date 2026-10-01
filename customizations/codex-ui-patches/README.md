# codex-ui「插件配置」分区补丁（社区包就地补丁）

## 这个补丁修什么

官方 `@michengai/dsh-codex-ui` 的 `registerPluginConfigSection` 把官方 PluginManagerPage 包进
`settings.section` 条目时，只转发了 `inject` / `locale`，**漏了 main 条目随带的 `store`**。官方页首渲染
即调用 `props.useStore()`（store 钩子由条目的 `store` 句柄生成，见 `dsh-client-ui-slots` 的
`standardHookPropName`），拿不到就抛：

```
TypeError: props.useStore is not a function
  → reportEntryError(abdicate) 退位通道
  → SlotCore.entriesOfSlot 永久排除该条目
  → 设置导航里「插件配置」点一下就消失，且不自愈（刷新页面才恢复）
```

用户表述：「插件配置又出现问题了，点击后就消失了，和以前一样」。

补丁本体只有两处，同一次 `slots.register` 里转发 `store`，并在准入判断里拒绝缺 store 的条目
（宁可不注册，也好过注册出一个必崩的条目再退位——退位是不可逆的）。

## 为什么会复发，以及这个目录为什么存在

补丁对象是 `home/profiles/web/node_modules/@michengai/dsh-codex-ui/lib/client.js`——一个
**会被 profile 依赖物化覆盖的 npm 包**。时间线：

| 时间 | 事件 | 该文件哈希 |
|---|---|---|
| 原始 | npm 包原版 | `04106142…` |
| 2026-09-28 | 就地打上补丁（当时只改了 `v4-rc2b` + 旧家园 `Data/DSH`） | `00cc596E…` |
| 2026-09-30 | 新建 `auto-020-rc2` 家园（源家园 `v5-020rc1` 当时**是**已打补丁的） | `04106142…` ← 退回原版，且 `nlink=2` 硬链到 pnpm store |
| 2026-10-01 | 本目录重放补丁，四份副本统一 | `00cc596E…` |

这与 AGENTS.md 记录的「profile 包 specifier 领先安装是地雷」是同一个坑：**npm 包上的就地手改天生守不住**。
所以补丁必须满足三条，否则下一个新家园/下一次 `pnpm install` 会原样复发：

1. **有仓库归属**——补丁写在 `customizations/` 里并登记进 `customizations/preservation.json`，
   不是会话记忆里的一句话加散落各家园的手改文件。
2. **有唯一重放入口**——`apply.mjs`，三态判定（已打 / 本次打 / 上游变形），变形时**非 0 退出**，
   绝不「没匹配上就算了」。静默跳过等于把同一个坑留给下一个人。
3. **有闸门**——见下。

## 用法

```sh
# 校验全部家园副本（只读；缺失或上游变形 → 退出码 1）
Tools/node-v26.10.0/node.exe customizations/codex-ui-patches/apply.mjs --verify --root .

# 重放补丁（幂等；已打过就 no-op）
Tools/node-v26.10.0/node.exe customizations/codex-ui-patches/apply.mjs --root .
```

覆盖范围：`Data/DSH`（旧家园）+ `Data/DSH-generations/*/home`（各代际）。没装 codex-ui 的家园跳过，不算问题。

## 写文件为什么必须 rename

目标常常是**硬链接到 pnpm store 的 inode**（`nlink=2`，见 2026-09-30 的 r4 审计记录）。`writeFileSync`
会**穿透**写进那个共享 inode，把整个 pnpm store 的原始包变成补丁版——污染依赖树、后续 pnpm 校验失真，
而且下次 store 重新物化时又会被打回，症状与现在一模一样。`apply.mjs` 先写同目录临时文件再 `renameSync`
覆盖目录项：只换掉这一个目录项，store 里的 inode 原样不动。打完之后该文件的 `nlink` 会变成 1，这是预期结果，
`test/codex-ui-patches.test.ts` 的实机巡检用例把 `nlink > 1` 判为失败。

## 闸门（都在 `.mjs` / 仓库脚本层，不需要打包）

| 位置 | 时机 | 行为 |
|---|---|---|
| `scripts/prepare-dsh-home-generation.mjs` | 新家园复制完成、**写绑定开关之前** | 应用补丁；失败即撤绑定 + 隔离整个代际目录 |
| `scripts/prepare-kernel-update.mjs` | 内核升级全部步骤跑完之后的收尾 | 复核全部家园副本；缺失即非 0 退出，升级不算完成 |
| `Build-DSH-Portable.ps1` | 「定制源码保护门禁」阶段 | `--verify` 只读校验；失败即阻断发布与候选暂存 |
| `test/codex-ui-patches.test.ts` | 全量测试 | 补丁逻辑三态 + 实机家园巡检（CI 无 `Data/` 时 skip） |

绑定开关一旦落盘就是「生效开关」，所以补丁必须落在它之前；`prepare-dsh-home-generation.mjs` 里那句
import 与 throw 的位置不是随手放的。

## 上游升级 codex-ui 之后

`apply.mjs` 会以 `PATCH_SHAPE_DRIFT` 报错并打印 `registerPluginConfigSection` 的现场。**不要**把
`from`/`to` 放宽成模糊匹配去「让它过」——那是把一个响亮的失败换成一个安静的回退。正确做法是人工看现场，
确认官方 PluginManagerPage 的 props 合同有没有变，再决定新补丁。

## 相关记录

- 首次修复：`docs/01-当前工作/20260928-插件配置入口点击消失修复.md`
- 本轮复发与防回退：`docs/01-当前工作/20261001-插件配置点击消失复发与防回退.md`
- 当天活体复现（r4 审计）：`docs/01-当前工作/20261001-全界面一致性核查与防分裂.md`
