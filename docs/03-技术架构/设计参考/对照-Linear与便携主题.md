# 对照 — Linear DESIGN.md 与便携版主题（参考吸收清单）

来源：`Linear-DESIGN.md`（VoltAgent/awesome-design-md 合集，Google Stitch 开源格式，与 Refero Styles 同类）。
用途：**参考吸收**，不替换现有 `assets/theme.css` 体系（基线门禁保护的令牌不动，吸收走正常登记流程）。

## 值得吸收（按价值排序）

1. **负字距阶梯**：Linear 大字号显示文本配递进负字距（80px→-3.0px，28px→-0.6px，正文→-0.05px）。我们的 `--chrome-*` 令牌没有字距刻度，标题类 UI（设置页大标题、关于页）可新增 `--chrome-tracking-*` 令牌组。
2. **「无阴影层级」备选形态**：四级表面阶梯（canvas→surface-1..4）+ 1px 发丝边框承载层级、完全不用阴影。我们目前层级靠 surface + shadow 双轨；在紧凑区域（菜单、抽屉）可借「边框代阴影」让视觉更轻。
3. **强调色稀缺纪律成文**：单色相 accent 只允许出现在品牌标 / 主 CTA / focus 环 / 链接强调，禁止装饰性使用（"Don't use lavender as a card fill"）。我们实际执行的就是这条，但没有写成规则——写进 UI 维护契约即可防止未来会话乱用。
4. **Do/Don't 清单形式**：把品味写成可执行的正反规则（如"Don't pill-round CTAs"、"Don't use true black as canvas"）。建议 UI 契约补一节同样格式的清单。

## 我们已经更好 / 不适用

1. **双主题**：Linear 明文 Don't 「light-mode marketing page」——便携版必须 light+dark 双全（浅色是用户主用态），直接照搬会砍掉一半产品能力。
2. **圆角体系**：Linear xs4/sm6/md8/lg12 与我们 `--chrome-radius` 8px/6px 同族，无需改。
3. **间距刻度**：4/8/12/16/24/32 与我们一致，无需改。
4. **自定义字体**（Linear Display/Text/Mono）：便携版不内嵌字体文件（体积与分发限制），维持系统字体栈。
5. **营销页专属**（canvas #010102、产品截图主角、96px section 节奏）：不适用于工具型桌面 UI。

## 落地方式

吸收项 1、3、4 落入「UI 定制维护契约」与 `assets/theme.css`（新增令牌走正常流程：改动 → 实机验证 → 截图证据 → 重录基线）；吸收项 2 作为新界面的备选形态备忘。**不引入任何 Linear 色值**——我们的 zinc 冷灰与 accent 由主题预设拥有。
