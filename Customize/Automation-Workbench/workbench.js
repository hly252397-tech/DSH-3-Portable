// Build-time extension of the automation plugin, not a second scheduler.
// Uses the same AutomationView and runtime created by the owning plugin.
function installPortableAutomationWorkbench(ctx, { React, createPortal, View, runtime, t, permissionT, modelT, Icon }) {
  const h = React.createElement;
  const namespace = "portable.automation.workbench";
  ctx.effect(() => ctx.locale.register(namespace, {
    zh: { title: "自动化", back: "返回工作区", hint: "任务与执行记录", open: "打开自动化工作台", settingsHint: "自动化任务已移至独立工作台；继续使用原有任务和执行记录。" },
    en: { title: "Automations", back: "Back to workspace", hint: "Tasks and run history", open: "Open automation workspace", settingsHint: "Manage automations in the dedicated workspace, using your existing tasks and run history." },
  }), "portable automation: locale");
  const text = ctx.locale.bind(namespace);
  let opened = false;
  let visited = false;
  let returnFocus;
  let restoreDetails = false;
  let disposed = false;
  const listeners = new Set();
  const source = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => opened,
  };
  const publish = () => { for (const listener of [...listeners]) listener(); };
  function open() {
    if (disposed || opened) return;
    returnFocus = document.activeElement;
    const details = document.querySelector('[data-slot="details"]');
    restoreDetails = !!details && details.getBoundingClientRect().width > 100;
    ctx.get?.("layout")?.closeDetails();
    visited = true;
    opened = true;
    publish();
  }
  function close({ focus = true } = {}) {
    if (!opened) return;
    opened = false;
    publish();
    if (restoreDetails) ctx.get?.("layout")?.openDetails();
    restoreDetails = false;
    if (focus && returnFocus?.isConnected && !document.querySelector('[role="dialog"]')) returnFocus.focus();
  }
  function Launcher({ wide }) {
    const active = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
    return h("button", { type: "button", className: "daw-launcher", "data-daw-launcher": "true", "aria-label": text("title"), title: text("title"), "aria-pressed": active, onClick: open },
      h(Icon, { size: 16, "aria-hidden": true }), wide ? h("span", null, text("title")) : null);
  }
  function Page() {
    const active = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
    const page = React.useRef(null);
    const heading = React.useRef(null);
    React.useLayoutEffect(() => {
      if (!active || !page.current) return;
      const sidebar = document.querySelector('aside.dcu-root, [data-slot="sidebar"] aside');
      const align = () => {
        if (page.current) page.current.style.left = Math.max(0, sidebar?.getBoundingClientRect().right || 0) + "px";
      };
      align();
      const observer = new ResizeObserver(align);
      if (sidebar) observer.observe(sidebar);
      window.addEventListener("resize", align);
      // Keep existing conversation DOM/drafts alive, but not keyboard-accessible behind the page.
      const covered = [...document.querySelectorAll('[data-slot="conversation"], [data-slot="details"], .dss-standalone-host')];
      const previous = covered.map(element => [element, element.inert]);
      for (const [element] of previous) element.inert = true;
      heading.current?.focus({ preventScroll: true });
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", align);
        for (const [element, inert] of previous) element.inert = inert;
      };
    }, [active]);
    if (!visited) return null;
    // Hide, do not remount: query, selected history tab and unsaved form survive navigation.
    return createPortal(h("section", { ref: page, className: "daw-page", hidden: !active, "aria-label": text("title"), onKeyDown: event => {
      if (event.key === "Escape" && !event.defaultPrevented && !page.current?.querySelector('.dsh-st-mask')) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    } },
      h("header", { className: "daw-header" },
        h("div", { className: "daw-identity" }, h(Icon, { size: 20, "aria-hidden": true }),
          h("h1", { ref: heading, tabIndex: -1 }, text("title")), h("span", null, text("hint"))),
        h("button", { type: "button", className: "daw-back", onClick: () => close() }, text("back"))),
      h("main", { className: "daw-content" }, h(View, { t, permissionT, modelT, runtime, closeSettings: () => close() }))
    ), document.body);
  }
  // Keep the old settings route as a clearly labelled link, not another copy of the manager.
  function SettingsLink({ close: closeSettings }) {
    return h("section", { className: "daw-settings-link" },
      h("h2", null, text("title")), h("p", null, text("settingsHint")),
      h("button", { type: "button", className: "dsh-st-btn dsh-st-btn--primary", onClick: () => { closeSettings?.(); open(); } }, text("open")));
  }
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "portable-automation-workbench", order: 10 }, Page));
  // Explicit replacement of the old shortcut under its stable id; no duplicate button.
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-automation", priority: -100, order: -20 }, Launcher));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "portable-automation-workbench";
    style.textContent = PORTABLE_AUTOMATION_WORKBENCH_CSS;
    document.head.appendChild(style);
    const onNavigation = event => {
      if (!opened || !(event.target instanceof Element)) return;
      const button = event.target.closest('aside button, aside a');
      if (!button || button.closest('.dcu-settings-seat') || button.hasAttribute('data-daw-launcher') || button.classList.contains('dcu-collapse')) return;
      close({ focus: false });
    };
    document.addEventListener("click", onNavigation, true);
    return () => {
      close({ focus: false }); disposed = true;
      document.removeEventListener("click", onNavigation, true);
      style.remove(); listeners.clear();
    };
  }, "portable automation: navigation and styles");
  return { SettingsLink, open, close };
}

const PORTABLE_AUTOMATION_WORKBENCH_CSS = `
.daw-page{position:fixed;inset:0 0 0 252px;z-index:100;display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#202124);font:14px/1.6 'Segoe UI','Microsoft YaHei UI',sans-serif}
.daw-page[hidden]{display:none!important}.daw-page *{box-sizing:border-box}
.daw-header{display:flex;flex:none;align-items:center;justify-content:space-between;gap:16px;min-height:64px;padding:12px 32px;border-bottom:1px solid var(--dsw-alias-border-l3,#ddd)}
.daw-identity{display:flex;align-items:center;gap:12px;min-width:0}.daw-identity h1{font-size:16px;font-weight:600;margin:0}.daw-identity span{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.daw-content{flex:1;min-height:0;overflow:auto;padding:32px clamp(20px,4vw,64px) 48px;scrollbar-gutter:stable}
.daw-content>.dsh-st-shell{max-width:1160px;margin:0 auto}.daw-content .dsh-st-heading-row h1{font-size:22px}.daw-content .dsh-st-examples{margin-block:24px}
.daw-back{border:1px solid var(--dsw-alias-border-l3,#ddd);background:transparent;border-radius:8px;padding:7px 12px;color:inherit;font:inherit;white-space:nowrap;cursor:pointer}
.daw-launcher{display:flex;align-items:center;gap:10px;width:100%;min-height:30px;border:0;border-radius:6px;padding:5px 6px;background:transparent;color:var(--dcu-sidebar-navigation,var(--dsw-alias-label-primary,#202124));text-align:left;font:14px/20px var(--dcu-font,'Segoe UI',sans-serif);cursor:pointer}
.daw-launcher:hover,.daw-launcher[aria-pressed=true],.daw-back:hover{background:var(--dsw-alias-interactive-bg-hover,#eee)}
.daw-launcher:focus-visible,.daw-back:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4b7760);outline-offset:2px}.daw-identity h1:focus{outline:none}
.dcu-compact .daw-launcher{justify-content:center;width:36px;padding:5px 0}.daw-settings-link p{color:var(--dsw-alias-label-secondary,#666)}
@media(max-width:900px){.daw-header{padding:12px 20px}.daw-identity span{display:none}.daw-content{padding:24px 20px}.daw-content .dsh-st-top{flex-wrap:wrap}}
@media(max-width:600px){.daw-header{padding:10px 12px}.daw-content{padding:16px 12px}.daw-content .dsh-st-example-row{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.daw-page *{scroll-behavior:auto}}
`;
