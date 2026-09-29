window.__ModuleLoader__.load({
	id: "dsh-custom-spaces",
	factory: (require) => {
		const module = { exports: {} };
		const react = require("react");
		const h = react.createElement;
		const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = react;

		const NS = "custom-spaces";
		const SETTINGS_NAMESPACE = "custom-spaces";
		const MAX_SPACES = 5;

		const zh = {
			"label": "自定义空间",
			"settings.nav": "自定义空间",
			"settings.hint": "最多 5 个空间；每个空间填名称和地址（http/https），取消勾选可隐藏入口。保存后立即生效。",
			"enabled": "显示",
			"name": "名称",
			"url": "地址",
			"add": "添加空间",
			"remove": "删除",
			"empty": "还没有自定义空间，点「添加空间」创建第一个。",
			"invalidUrl": "地址必须以 http:// 或 https:// 开头",
			"saved": "已保存",
			"saveRejected": "未保存：配置不可写或已变化，请重试。草稿已保留。",
			"browserUnavailable": "侧边浏览器暂不可用，请启用浏览器卡片后重试。",
			"openFailed": "打开空间失败",
			"noSession": "当前没有打开的会话：先点左侧任意任务（或新建任务），再点本入口，会在侧边浏览器打开。",
		};
		const en = {
			"label": "Spaces",
			"settings.nav": "Custom Spaces",
			"settings.hint": "Up to 5 spaces. Fill in a name and an http/https URL; uncheck to hide an entry. Changes apply immediately.",
			"enabled": "Show",
			"name": "Name",
			"url": "URL",
			"add": "Add space",
			"remove": "Remove",
			"empty": "No custom spaces yet — click \"Add space\" to create one.",
			"invalidUrl": "URL must start with http:// or https://",
			"saved": "Saved",
			"saveRejected": "Not saved: configuration is unavailable or changed. Your draft is kept; please retry.",
			"browserUnavailable": "The sidebar browser is unavailable. Enable the browser card and retry.",
			"openFailed": "Failed to open space",
			"noSession": "No session is open: pick any task on the left (or create one), then click this entry to open it in the sidebar browser.",
		};

		function isHttpUrl(value) {
			return /^https?:\/\//i.test(String(value || "").trim());
		}

		// better-sidebar 属可选依赖：未启用时明确提示，不启动第二套浏览器。
		let sidecard = null;
		function captureSidecard(ctx) {
			try {
				ctx.inject(["betterSidebar"], (inner) => {
					inner.effect(() => {
						const service = inner.betterSidebar;
						sidecard = service;
						return () => { if (sidecard === service) sidecard = null; };
					});
				});
			} catch (_) {}
		}
		// 2026-09-20 修「点击没反应」：better-sidebar 的 openTab 在**无活动会话**（欢迎页）时
		// 静默 return（sessionId 为 undefined 直接返回、不抛错），本插件原先把"没抛错"当成功，
		// 无会话、浏览器未注册都明确提示；正常时走唯一的完整浏览器卡片。
		function toast(message) {
			try {
				const old = document.querySelector(".dcs-toast");
				if (old) old.remove();
				const el = document.createElement("div");
				el.className = "dcs-toast";
				el.setAttribute("role", "status");
				el.textContent = String(message || "");
				document.body.appendChild(el);
				setTimeout(() => { try { el.remove(); } catch (_) {} }, 4200);
			} catch (_) {}
		}
		/** 会话存在性的响应式快照（"none"/"some"/"unknown"），供入口行预告"需先开会话"。 */
		function useHasSession() {
			const subscribe = useCallback((listener) => (sidecard && typeof sidecard.subscribeState === "function") ? sidecard.subscribeState(listener) : () => {}, []);
			const getSnapshot = useCallback(() => {
				if (!sidecard || typeof sidecard.getSnapshot !== "function") return "unknown";
				try {
					const snap = sidecard.getSnapshot();
					const id = snap ? snap.sessionId : undefined;
					return id === undefined || id === null || id === "" ? "none" : "some";
				} catch (_) { return "unknown"; }
			}, []);
			return useSyncExternalStore(subscribe, getSnapshot);
		}
		function openSpace(space, t) {
			const url = String(space.url || "").trim();
			if (!isHttpUrl(url)) return false;
			if (sidecard && typeof sidecard.openTab === "function") {
				let sessionId;
				try { sessionId = typeof sidecard.getSnapshot === "function" ? sidecard.getSnapshot().sessionId : undefined; } catch (_) { sessionId = undefined; }
				if (sessionId === undefined || sessionId === null || sessionId === "") {
					toast(t("noSession"));
					console.warn("[dsh-custom-spaces] no active session; better-sidebar openTab would no-op:", url);
					return false;
				}
				if (typeof sidecard.getTab === "function" && sidecard.getTab("browser") === undefined) {
					toast(t("browserUnavailable")); return false;
				}
				try {
					sidecard.openTab({ type: "browser", url, title: space.name || url });
					return true;
				} catch (_) { toast(t("openFailed")); return false; }
			}
			toast(t("browserUnavailable")); return false;
		}

		function ensureStylesheet() {
			if (document.querySelector('style[data-plugin="dsh-custom-spaces"]')) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-custom-spaces";
			tag.textContent = [
				".dcs-group{display:flex;flex-direction:column;gap:2px;width:100%;min-width:0;padding:2px 4px 6px;border-bottom:1px solid var(--dcu-sidebar-border,var(--dcu-border,transparent))}",
				// 2026-09-21：本组作为**具名查询容器**。容器查询只影响后代、不影响自身，正合适。
				".dcs-group{container:dcs-group / inline-size}",
				// ── 默认 = 安全窄态（opt-in 展开）────────────────────────────────────
				// 不依赖第三方 .dcu-compact 类、也不依赖挂载时序：这样「类还没加上、列已经变窄」的
				// 启动帧不会把展开排版塞进窄盒（旧写法会：名字宽度归零 → 逐字竖排 → 页脚涨到 294px）。
				".dcs-title{display:none;padding:2px 10px 4px;font:600 11px/16px var(--dcu-font,inherit);letter-spacing:.4px;color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit));text-transform:uppercase}",
				".dcs-item{display:flex;align-items:center;justify-content:center;gap:0;flex:none;width:36px;height:36px;min-width:0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dcu-sidebar-icon,#52525b);font:500 13px/18px var(--dcu-font,inherit);cursor:pointer;text-align:left}",
				".dcs-item:hover{background:var(--dcu-sidebar-hover,#f4f4f5);color:var(--dcu-sidebar-primary,#18181b)}",
				".dcs-icon{display:grid;place-items:center;flex:none;width:20px;height:20px;color:inherit;background:transparent}",
				".dcs-icon svg{display:block;width:16px;height:16px}",
				".dcs-name{flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere}",
				".dcs-name{display:none}",
				".dcs-item:focus-visible{outline:2px solid var(--dcu-sidebar-accent,#5b9dd9);outline-offset:-2px}",
				".dcu-compact .dcs-group{padding:0 0 8px;gap:4px;box-sizing:border-box}",
				".dcu-compact .dcs-title,.dcu-compact .dcs-name,.dcu-compact .dcs-empty{display:none}",
				".dcu-compact .dcs-group:not(:has(.dcs-item)){display:none}",
				".dcu-compact .dcs-item{width:36px;height:36px;padding:0;gap:0;justify-content:center;background:transparent;color:var(--dcu-sidebar-icon,#52525b)}",
				".dcu-compact .dcs-item:hover{background:var(--dcu-sidebar-hover,#f4f4f5);color:var(--dcu-sidebar-primary,#18181b)}",
				".dcu-compact .dcs-icon{color:inherit;background:transparent}",
				".dcs-empty{padding:2px 10px 6px;font:400 12px/17px var(--dcu-font,inherit);color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit))}",
				// 组自身的展开态留白：容器查询改不了容器自己，所以这条继续按第三方类（纯留白，不参与"会不会折行"）。
				".dcu-root:not(.dcu-compact) .dcs-group{padding:4px 4px 10px;gap:6px;border-bottom:0}",
				// ── 展开态 = opt-in：只有容器**实测够宽**才进入 ─────────────────────
				// 阈值 200px 由 120/150/180/200/220/250/280/320px 宽度扫描实测：180px 折 2 行、200px 起稳定单行。
				// 因为展开是"证明够宽后才发生"，第三方 class 早一帧晚一帧都不再影响我们的几何。
				"@container dcs-group (min-width:200px){",
				"  .dcs-title{display:block;padding:0 8px;letter-spacing:0;font-weight:500}",
				"  .dcs-name{display:block}",
				"  .dcs-item{justify-content:flex-start;width:100%;height:auto;min-height:42px;padding:7px 10px;gap:8px;background:var(--dcu-sidebar-hover,#f4f4f5);border-radius:9px}",
				"  .dcs-item:hover{background:color-mix(in srgb,var(--dcu-sidebar-accent,#5b9dd9) 12%,var(--dcu-sidebar-hover,#f4f4f5))}",
				"  .dcs-icon{width:26px;height:26px;border-radius:7px;background:color-mix(in srgb,var(--dcu-sidebar-accent,#5b9dd9) 10%,transparent)}",
				"}",
				// 计费卡是**兄弟节点**（不在本容器内）。2026-09-23：真实类名是 .VWh0dG_trigger（billing-trigger 只是
				// container 名，不是 data-testid）——旧选择器从未命中。仪表弧被盒裁成 C 形 → 隐藏装饰仪表，
				// 标签与「自定义空间」左缘对齐；柱图靠右。
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_triggerWrap{width:100%}",
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_trigger{box-sizing:border-box;width:100%;min-height:52px;padding:8px 12px;border-radius:9px;overflow:visible;display:grid!important;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;row-gap:2px;align-items:center;gap:0}",
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_triggerIcon{display:none}",
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_triggerMain{grid-column:1;grid-row:1;display:flex;flex-direction:column;gap:2px;min-width:0}",
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_triggerLabel{padding-left:0;line-height:16px;text-align:left}",
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_triggerPrimary{gap:5px}",
				".dcu-root:not(.dcu-compact) .dcu-footer-actions:has(.dcs-group) .VWh0dG_triggerSpark{grid-column:2;grid-row:1;margin-left:0;opacity:.85;align-self:center}",
				// End I023/56 footer appearance.
				".dcs-form{display:flex;flex-direction:column;gap:12px;max-width:560px}",
				".dcs-hint{font:400 12px/18px var(--dcu-font,inherit);color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit))}",
				".dcs-row{display:grid;grid-template-columns:auto 1fr 2fr auto;gap:8px;align-items:center}",
				".dcs-row input[type=checkbox]{margin:0}",
				".dcs-row input[type=text]{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dcu-sidebar-border,var(--dcu-border,#ccc));border-radius:6px;background:transparent;color:inherit;font:inherit}",
				".dcs-row-head{font:600 12px/17px var(--dcu-font,inherit);color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit))}",
				".dcs-actions{display:flex;gap:8px;align-items:center}",
				".dcs-btn{padding:6px 12px;border:1px solid var(--dcu-sidebar-border,var(--dcu-border,#ccc));border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}",
				".dcs-btn.primary{background:var(--dcu-sidebar-accent,var(--dcu-accent,#5b9dd9));border-color:transparent;color:#fff}",
				".dcs-err{font:400 12px/17px var(--dcu-font,inherit);color:#e06c6c}",
				".dcs-ok{font:400 12px/17px var(--dcu-font,inherit);color:#69b779}",
				".dcs-dot-wait{flex:none;width:6px;height:6px;border-radius:50%;background:#d29922}",
				".dcs-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:8px 14px;border:1px solid var(--dcu-sidebar-border,var(--dcu-border,#ccc));border-radius:10px;background:var(--dcu-sidebar-hover,#f4f4f5);color:var(--dcu-sidebar-primary,var(--dcu-text-primary,inherit));font:500 12px/18px var(--dcu-font,inherit);box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:none}",
			].join("\n");
			document.head.appendChild(tag);
		}

		function useScopeSnapshot(scope) {
			const subscribe = useCallback((listener) => scope.subscribe(listener), [scope]);
			const getSnapshot = useCallback(() => scope.getSnapshot(), [scope]);
			return useSyncExternalStore(subscribe, getSnapshot);
		}

		function readSpaces(snapshot) {
			const spaces = Array.isArray(snapshot.value?.spaces) ? snapshot.value.spaces : [];
			return spaces.filter((space) => space && String(space.url || "").trim());
		}

		/** 侧栏底部入口分组（sidebar.footer.action 槽）。 */
		function SpacesEntry({ scope, t }) {
			const snapshot = useScopeSnapshot(scope);
			const sessionState = useHasSession();
			const spaces = readSpaces(snapshot).filter((space) => space.enabled !== false).slice(0, MAX_SPACES);
			if (!spaces.length) {
				return h("div", { className: "dcs-group" },
					h("div", { className: "dcs-title" }, t("label")),
					h("div", { className: "dcs-empty" }, t("empty")));
			}
			return h("div", { className: "dcs-group" },
				h("div", { className: "dcs-title" }, t("label")),
				spaces.map((space, index) => h("button", {
					type: "button",
					key: `${index}:${space.url}`,
					className: "dcs-item",
					title: (space.name ? `${space.name}\n${space.url}` : space.url) + (sessionState === "none" ? `\n${t("noSession")}` : ""),
					"aria-label": space.name || space.url,
					onClick: () => { if (!openSpace(space, t)) console.warn("[dsh-custom-spaces] " + "open failed:", space.url); },
				}, h("span", { className: "dcs-icon", "aria-hidden": "true" },
					h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7 },
						h("rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
						h("rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
						h("rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
						h("rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }))),
					h("span", { className: "dcs-name" }, space.name || space.url),
					sessionState === "none" ? h("span", { className: "dcs-dot-wait", "aria-hidden": "true" }) : null)));
		}

		/** 设置页（settings.section 槽）：5 个空间的可视化编辑。 */
		function SpacesSettings({ scope, t, renderSlot }) {
			const snapshot = useScopeSnapshot(scope);
			const remote = Array.isArray(snapshot.value?.spaces) ? snapshot.value.spaces : [];
			// 🔴 2026-09-20 修：原先 value 直接绑异步快照 + 每敲一键就写盘一次 ——
			//    打字快过「写盘→回读」一个来回时，旧值回写会覆盖新输入（实测 25ms/键丢字：
			//    FASTABCDEFGHIJ → 只剩 TEA）。改为**本地草稿 + debounce 落盘**：
			//    输入只改 draft（画面即时），停 400ms 后才写一次盘；写成功才交回快照。
			const [draft, setDraft] = useState(null);
			const spaces = draft === null ? remote : draft;
			const writable = snapshot.status === "ready" && snapshot.writable === true;
			const [notice, setNotice] = useState(null);
			const timer = useRef(null);
			const generation = useRef(0);
			useEffect(() => () => {
				generation.current++;
				if (timer.current !== null) clearTimeout(timer.current);
			}, []);
			function commit(next, version) {
				const current = scope.getSnapshot();
				if (current.status !== "ready" || current.writable !== true) {
					setNotice({ kind: "err", text: t("saveRejected") }); return;
				}
				if (next.some(space => String(space.url || "").trim() && !isHttpUrl(space.url))) {
					setNotice({ kind: "err", text: t("invalidUrl") }); return;
				}
				setNotice(null);
				void scope.set("spaces", next)
					.then((accepted) => {
						if (version !== generation.current) return;
						if (accepted !== true) { setNotice({ kind: "err", text: t("saveRejected") }); return; }
						setNotice({ kind: "ok", text: t("saved") }); setDraft(null);
					})
					// 写失败**保留草稿**：那是用户还没保存的内容，回退会让他白打一遍。
					.catch((cause) => {
						if (version === generation.current) setNotice({ kind: "err", text: String(cause && cause.message || cause) });
					});
			}
			function edit(next) {
				const version = ++generation.current;
				setDraft(next);
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => { timer.current = null; commit(next, version); }, 400);
			}
			function patch(index, field, value) {
				edit(spaces.map((space, i) => i === index ? { ...space, [field]: value } : space));
			}
			function add() {
				if (spaces.length >= MAX_SPACES) return;
				edit([...spaces, { name: "", url: "", enabled: true }]);
			}
			function remove(index) {
				edit(spaces.filter((_, i) => i !== index));
			}
			const badUrl = spaces.some((space) => String(space.url || "").trim() && !isHttpUrl(space.url));
			return h("div", { className: "dcs-form" },
				h("div", { className: "dcs-hint" }, t("settings.hint")),
				spaces.map((space, index) => h("div", { key: index },
					h("div", { className: "dcs-row-head" }, `#${index + 1}`),
					h("div", { className: "dcs-row" },
						h("label", { title: t("enabled") },
							h("input", { type: "checkbox", disabled: !writable, checked: space.enabled !== false, onChange: (event) => patch(index, "enabled", event.target.checked) })),
						h("input", { type: "text", disabled: !writable, value: space.name || "", placeholder: t("name"), onChange: (event) => patch(index, "name", event.target.value) }),
						h("input", { type: "text", disabled: !writable, value: space.url || "", placeholder: t("url"), onChange: (event) => patch(index, "url", event.target.value) }),
						h("button", { type: "button", disabled: !writable, className: "dcs-btn", onClick: () => remove(index) }, t("remove"))))),
				spaces.length < MAX_SPACES ? h("div", { className: "dcs-actions" },
					h("button", { type: "button", disabled: !writable, className: "dcs-btn primary", onClick: add }, t("add"))) : null,
				badUrl ? h("div", { className: "dcs-err" }, t("invalidUrl")) : null,
				notice ? h("div", { className: notice.kind === "ok" ? "dcs-ok" : "dcs-err" }, notice.text) : null,
				renderSlot("custom-spaces.services", {}));
		}

		const inject = ["locale", "configForms", "slots"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-custom-spaces: dictionaries");
			const t = ctx.locale.bind(NS);
			const scope = ctx.configForms.get(SETTINGS_NAMESPACE);
			ensureStylesheet();
			captureSidecard(ctx);
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "custom-spaces-entry",
				order: -100,
				locale: NS,
				inject: () => ({ scope, t })
			}, SpacesEntry));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "custom-spaces",
				children: { "custom-spaces.services": { kind: "list", scope: "global" } },
				order: 19,
				label: () => t("settings.nav"),
				locale: NS,
				inject: () => ({ scope, t })
			}, SpacesSettings));
		}

		module.exports.apply = apply;
		module.exports.inject = inject;
		return module.exports;
	}
});
