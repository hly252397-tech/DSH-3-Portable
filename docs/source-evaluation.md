# P3 Tiny Watch 数据源评估（P3.1）

> 评估日期：2026-09-19。实测环境：用户本机网络（直连，代理设置未知），统一使用插件诚实 UA
> `DSH-P3-Tiny-Watch/0.1 (+local price monitor)`，不伪装浏览器、不登录、不绕过验证码。
> 实测脚本未入库（探针属一次性侦察），本文保留结论与证据摘要。

## 目标

为 `dsh-p3-tiny-watch` 寻找可持续、合规的真实数据源，替代对本机返回 HTTP 403 的 eBay
公开搜索页，并完成一次真实 listing 数据闭环。

## A. 官方 API（优先级 ★★★★★，需用户参与）

| 来源 | 结论 |
|---|---|
| eBay Browse API | 唯一与现役监控语义完全匹配的官方通道。需要：eBay 开发者账号注册 → 生产密钥（免费档，每日数千次调用）→ OAuth 授权。**注册与密钥申请必须由用户本人完成**，智能体无法代办。接入后建议作为独立 `SourceAdapter`（`ebay-api`）加入，与现有架构兼容。 |
| 闲鱼/转转/淘宝 | 均无公开官方 API；开放接口全部要求登录态 + 签名（mtop 等），不符合插件安全边界。 |

## B. 公开 RSS / Feed（优先级 ★★）

| 来源 | 实测结果 |
|---|---|
| eBay `_rss=1` | **403**（且该参数已无 RSS 语义，返回的是错误页）。eBay 搜索 RSS 服务已死。 |
| Craigslist RSS（`format=rss`） | **403**（响应体 "blocked"；无法区分是反爬还是网络拦截，本机不可用）。 |
| 其他商品搜索 RSS | 未发现可用的国际二手平台搜索 RSS。 |

结论：RSS 路线在本机网络下不可行，暂不投入。

## C. 二手平台公开页面（无登录、无验证码，优先级 ★★★★）

2026-09-19 实测（GET，12s 超时，诚实 UA）：

| 来源 | 状态 | 判定 |
|---|---|---|
| **kleinanzeigen.de**（前 eBay Kleinanzeigen，德国） | **200**，246 KB 真实搜索结果页 | ✅ **已接入**。每卡片含 `data-adid`、详情链接、内嵌 ld+json（title/description）、价格节点（德式千分位，如 `1.300 €` = 1300 欧元）。价格 EUR，走配置汇率折 CNY。 |
| gumtree.com（英国） | 200，402 KB | 备选。页面结构未解析（本轮未投入），需要时按同样方式新增适配器。 |
| ebay.com / ebay.de | **403**（"Error Page \| eBay"） | ❌ 反爬拒绝。已按任务要求降级为 `SOURCE_BLOCKED`（`status: "blocked"`, `reason: "anti_bot"`），不再依赖其 HTML 抓取。 |
| goofish.com（闲鱼 Web） | 200 但仅 ~11 KB 通用首页壳 | ❌ 搜索结果需登录态 + mtop 签名，HTML 无数据，不符合"公开访问"标准。 |
| zhuanzhuan.com（转转） | 200 但 ~2.6 KB 壳页 | ❌ 同上。 |
| s.taobao.com | 200 但为拦截/壳页 | ❌ 同上。 |
| olx.pl / reddit / backmarket | 403（Backmarket 为 Cloudflare 挑战页） | ❌ 不可用。 |

## 已接入的真实闭环（2026-09-19 实测）

`kleinanzeigen.de` 搜索页 → 插件管线（fetch → parse → normalize → dedupe → storage →
threshold → alert）：

- 3 条真实 listing 全部抓取成功，run.status = success，0 错误；
- 价格解析正确（999 € / 1.300 € / 800 €，德式千分位无误差）；
- CPU 识别正确（`i7-14700T` 条目 confidence 1.0；无 CPU 信息条目 `CPU_UNKNOWN` 软标记 0.83）；
- EUR→CNY 折算 6240–10140 元，均高于 1500 元阈值 → 0 报警（阈值环节真实执行，未命中即诚实输出）。

## 结论与建议

1. **默认源切换为 kleinanzeigen.de**（已实施）；eBay 域名保留在允许列表，等官方 API 接入。
2. **下一步最优路径**：由用户注册 eBay 开发者账号，接入 Browse API（免费档），恢复美/英市场覆盖。
3. 国内市场（闲鱼/转转）在合规边界内无解；如未来有官方开放接口再评估。
4. 所有适配器遵守统一安全边界：诚实 UA、HTTPS-only、拒绝内网、不登录、不绕过风控；
   403 一律记 `SOURCE_BLOCKED`，绝不伪装浏览器重试。

## 剩余风险

- kleinanzeigen.de 为德国市场，货源以 EUR 计价，与"国内到手价"存在税运差异，阈值命中率会偏低；
  页面结构变更是解析器的长期风险（已按卡片结构 + ld+json 双通道解析，降低单点依赖）。
- eBay 官方 API 的 OAuth（用户 token）接入工作量中等，需要用户先完成账号注册。
