# dsh-p3-tiny-watch

DSH 本地插件，用于监控 Lenovo ThinkStation P3 Tiny 二手与企业退役货源。

## 功能

- `/p3-tiny-check`：立即检查公开 HTTPS 来源。
- `/p3-tiny-status`：查看最近检查、最低价、中位价与错误。
- `/p3-tiny-list [数量]`：查看最近货源。
- `/p3-tiny-config`：查看当前阈值、来源和数据目录。
- 默认每 168 小时检查一次；DSH 重启后根据最后成功/失败检查时间判断是否到期，不重复注册定时器。
- 对配件、空壳、租赁、预售、代际冲突、损坏/未测试和缺件进行标记或过滤。
- 支持 JSON feed、JSON-LD 商品页及 eBay 搜索结果的有限 HTML 解析。
- 命中后通过 DSH Portable 已有 IPC 通知契约发送桌面通知；CLI 环境下静默降级为持久化记录。

## 默认监控条件

- 目标价：1500 CNY/台。
- 来源：eBay US 与 eBay UK 公开搜索页。
- 估算汇率：在插件配置中维护，购买前必须人工核对实时汇率、运费、税费和机器状态。

## 安全边界

- 只访问 HTTPS。
- 拒绝 localhost、回环地址和常见内网地址。
- 默认仅允许 eBay 域名，可通过 `sourceAllowlist` 显式增加公开域名。
- 不读取 Cookie、不绕过验证码、不访问登录后页面、不保存页面正文。
- 自动测试不访问真实网站。

## 数据目录

```text
$DSH_HOME/plugin-data/dsh-p3-tiny-watch/
├── state.json
├── runs.jsonl
├── listings.jsonl
└── alerts.jsonl
```

写入采用临时文件 + 同目录改名；失败时不会覆盖旧状态。
