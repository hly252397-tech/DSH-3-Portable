# dsh-earthquake-alert · 已接受来源归档

**归档时间**：2026-10-01 18:0x（+08）
**归档人**：本会话（地震预警插件 UI/交互重构会话）
**清单登记**：`customizations/preservation.json` → pluginName `dsh-earthquake-alert`，sourceDir `plugins/dsh-earthquake-alert`

**受保护文件共 5 个**（本目录即这 5 个文件的已接受快照）：

```
cordis.patch.yml
lib/client.js
lib/index.js
lib/preferences.js
package.json
```

> `README.md` 与 `apply.mjs` **不在**本插件的受保护清单内（曾因窗口切片读越界误判为 7 个文件，见第 4 节）。

## 1. 差异说明（`lib/client.js` 为何需要重新登记）

本会话对 `lib/client.js` 做了大幅重构，其中**一项是我引入的回归**，如实记录：

| 项 | 内容 |
|---|---|
| 引入的回归 | `enable-sound` 动作的 `onClick` 被改成块箭头却**没有 `return` promise**。调用方 `await` 立即通过 ⇒ `resumes` 已 +1 但 `audio/soundReady` 尚未落定；随后时钟推进触发 `bounded` 超时 ⇒ enable 走 catch ⇒ `stopAudio()` 把音频置空 ⇒ **新报告不再发声**。 |
| 连带影响 | 按用户要求删「启用声音」按钮时，把 `data-dshea-action="enable-sound"` 契约钩子一并删掉 ⇒ 根契约测试 27 项挂 10 项，并让另一会话的重建门禁失效。 |
| 修法 | ① 动作钩子挂回**常驻** `<label>`（不恢复按钮），`onClick` 恒存在、`preventDefault?.()` 可选调用；② `onClick` **return** 该 promise；③ 横幅锚定 effect 加 DOM 能力探测（纯净沙箱缺 `querySelector/getComputedStyle/addEventListener` 时放弃测量——锚定是纯视觉增强，不得拖垮横幅）；④ 恢复胶囊化时被删的结构契约：`.dshea-banner-head`(role=alert)、`.dshea-banner-body`(aria-live=off)、`.dshea-pill.dshea-pill-test`「演示」徽标、文本含「第 N 报」。 |

**本次清单更新**：仅 `lib/client.js` 一条 sha256（`99e687e7…` → `d277e715…`）。**未触碰任何其它插件条目。**

## 2. 反向对照与真实验收

| 制品 | `lib/client.js` sha256(前 8) | 根契约测试 |
|---|---|---|
| 已接受基线 | `99e687e7` | **#25 通过**（护栏 #3 挂，因其断言的是新设计） |
| 我的修复前状态 | `9cd5d2ca` | **#25 失败**（`0 !== 3`）⇒ 证实回归由我引入 |
| 我的修复后状态 | `d277e715` | **44/44 全绿**（客户端 27 + 宿主 17） |

```
node --check plugins/dsh-earthquake-alert/lib/client.js                                  → exit 0
node scripts/gate-node-run.mjs scripts/run-tests.mjs dist/test/earthquake-client.test.js \
                                                    dist/test/earthquake-host.test.js    → 44/44 pass
node dist/scripts/check-customization-preservation.js --source-only --root <便携根>       → PASS（exit 0）
node --test plugins/dsh-earthquake-alert/test/ui-tokens.test.mjs                         → 5/5
诊断脚手架残留（__beacon/__sb/__dbg/DSHEA-DEBUG/临时诊断）                                → 全部 0 命中
```

## 3. README 增加了「改这个插件之前（强制前置）」

`plugins/dsh-earthquake-alert/README.md` 顶部新增一节：改前先跑基线（含正确的两个契约测试文件与命令）、受保护文件与 `--source-only` 校验、结构重写前的「契约面」清单、`return` 语义类陷阱、以及 vm 沙箱调试注意点。
**README 不在受保护清单内，故此节不产生漂移**（实测校验器仍 PASS）。

## 4. 事故记录：我自己把这份清单写坏过一次，已还原

新增 README 小节时，我误以为 README 也受保护，于是写脚本去改清单。脚本用**窗口切片**（取 `pluginName` 后 1200 字符）统计条目，切片越过了下一个插件的块，得出"7 个受保护文件"的错误前提；随后在该错误块内找不到 README 条目，`$newBlock` 变成 null，`前缀 + null + 后缀` **把整个插件条目从清单里删掉**（JSON 仍合法，脚本自检没拦住）。

**发现与还原**：靠体积差（18411 → 17558 字节，正好等于 853 字节的块长）与 `pluginName` 计数（14 → 13）发现；用崩溃前备份 `preservation.json.bak-readme-20261001-180828`（含 `d277e715`）还原，校验器随即回到 PASS。

**沉淀**：改共享清单前必须①定位完整块（`pluginName` 到下一个 `pluginName`）②核对条目数与文件体积③失败路径不得让 `$newBlock` 为空就拼接。已写进 README 前置第 ② 条。

## 5. 备份与回滚

- `preservation.json.bak-earthquake-client-20261001-180047` —— 本次更新前（client.js 仍为 `99e687e7`）
- `preservation.json.bak-readme-20261001-180828` —— 崩溃前完整状态（client.js = `d277e715`，**还原用此份**）
- 回滚：还原上述任一份即可退回到对应的接受状态。

## 6. 未闭合并如实上报

- `release/win-unpacked/resources/preservation.json` 与仓库清单（revision 7）脱节 11 条，快通道脚本自身要求**全量重建**；该重建跨本会话之外的插件变更（`dsh-agentos-learn` / `dsh-runtime-identity` 等），且规程禁止构建与候选激活并行 ⇒ **不由本会话发起**，也不为其在途改动背书。
- 本文件不含任何 `app-restart` / `app-quit` 字面量；客户端改动**只需刷新页面**生效。
