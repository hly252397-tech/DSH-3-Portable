# dsh-p3-tiny-watch

DSH 本地插件，用于监控 Lenovo ThinkStation P3 Tiny 二手与企业退役货源。

## 功能

- `/p3-tiny-check`：立即检查公开 HTTPS 来源。
- `/p3-tiny-status`：查看最近检查、最低价、中位价与错误。
- `/p3-tiny-list [数量]`：查看最近货源。
- `/p3-tiny-config`：查看当前阈值、来源和数据目录。
- 默认每 168 小时检查一次；DSH 重启后根据最后成功/失败检查时间判断是否到期，不重复注册定时器。
- 对配件、空壳、租赁、预售、代际冲突、损坏/未测试和缺件进行标记或过滤。
- 支持来源适配器（SourceAdapter）架构：每个来源一个适配器，统一 `fetchListings` 接口，
  价格规范化统一走 core 的 `normalizeListing`。内置适配器：
  - `kleinanzeigen`：kleinanzeigen.de 公开搜索页（默认源，含德式价格解析）。
  - `http-feed`：通用 JSON feed / JSON-LD 商品页 / eBay 卡片的有限 HTML 解析。
  - `mock`（开发用）：`mock://fixed` 固定样本（¥1200 / ¥1800 / ¥2200），仅当配置
    `enableMockSource: true` 时注册，用于离线验证完整链路；产出一律标记 `source: mock`。
- 错误码区分：`SOURCE_BLOCKED`（403/401，来源反爬拒绝，附 `status: "blocked"` 与
  `reason: "anti_bot" | "auth_required"`）、`UPSTREAM_ERROR`（5xx，暂时不可用）、
  `RATE_LIMIT`（429）、`NETWORK_ERROR`/`TIMEOUT`（连接层）。
- 命中后通过 DSH Portable 已有 IPC 通知契约发送桌面通知；CLI 环境下静默降级为持久化记录。

## 默认监控条件

- 目标价：1500 CNY/台。
- 默认来源：kleinanzeigen.de 公开搜索页（`https://www.kleinanzeigen.de/s-lenovo-p3-tiny/k0`）。
  eBay 公开搜索页自 2026-09 起对本机返回 HTTP 403（反爬），已从默认来源移除、降级为
  `SOURCE_BLOCKED` 语义；域名仍在允许列表中，接入 eBay 官方 API 前可手动加回 URL。
- 估算汇率：在插件配置中维护，购买前必须人工核对实时汇率、运费、税费和机器状态。

## 安全边界

- 只访问 HTTPS（mock 适配器仅 `mock://fixed` 且需显式启用）。
- 拒绝 localhost、回环地址和常见内网地址。
- 域名允许列表默认含 kleinanzeigen.de 与 eBay 域名，可通过 `sourceAllowlist` 增删。
- 不读取 Cookie、不伪装浏览器 UA、不绕过验证码、不访问登录后页面、不保存页面正文。
- 自动测试不访问真实网站（真实来源的模块级验证脚本不入库）。

## 数据目录

```text
$DSH_HOME/plugin-data/dsh-p3-tiny-watch/
├── state.json
├── runs.jsonl
├── listings.jsonl
└── alerts.jsonl
```

写入采用临时文件 + 同目录改名；失败时不会覆盖旧状态。
