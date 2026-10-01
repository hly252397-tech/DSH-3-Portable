// dsh-hj-workbench —— 客户端半侧：注册侧边栏 tab + 一张服务状态卡。
//
// 架构定稿（用户 2026-09-20 令「按照你的建议来」）：
//   · **入口不在这里造** —— 「物料录入工作台」「宏建云 ERP」都放在用户自己的
//     `dsh-custom-spaces`（设置 → 自定义空间）里：现成接口、名称/URL 全可编辑、单个开关。
//     之前我另造过一套「宏建云」入口组 + ERP 编辑框 —— 那是重复 UI，已撤除。
//   · 本插件只提供**自定义空间做不到的两件事**：
//       ① 宿主侧「启动即确保服务在跑」+ 唤醒路由（静态站要本机 HTTP 服务，前端起不了进程）；
//       ② `+` 新建菜单里的独立 tab 类型（registerTab，与知识中心/数据库/Inventor 同级）。
//   · 外加一张**设置卡**：看服务状态 / 手动唤醒 / 只探活 —— 排障用，不参与日常入口。
// better-sidebar 是可选依赖：没装则 tab 不注册，卡片与唤醒仍可用。
//
// 2026-09-20 实测记录（运行实例内探针取证，非推测）：
//   · 本 tab 渲染正常：1429×1299，工具条 + iframe(1429×1255) 均在；elementFromPoint 采样点
//     全部命中本 iframe → 不是塌陷、不是遮罩。
//   · 根元素用 `height:100%` 与 `flex:1` 实测同高（都 1299）→ 原「CSS 塌陷」推断被证伪；
//     此处仍按内置 tab 规范写 flex:1（.subagent / .sidechat 同款）。
//   · 程序化点开 `+`（nArs4W_tabBarPlus /「新建标签页」）后本 tab 依旧正常
//     → 「打开 + 菜单」不会让本 tab 变白。
window.__ModuleLoader__.load({
  id: 'dsh-hj-workbench',
  factory: (require) => {
    const module = { exports: {} };
    const react = require('react');
    const h = react.createElement;
    const { useCallback, useEffect, useState } = react;

    const NS = 'hj-workbench';
    const API = '/api/dsh-hj-workbench';

    const zh = {
      entry: '物料录入工作台',
      card: '工作台服务管理',
      hint: '工作台是本地静态站（要读 data/*.json），必须有本机 HTTP 服务；插件已在应用启动时确保它在跑。',
      whereHint: '工作台的名称和地址可在上方空间列表中维护；以下操作用于服务检查与恢复。',
      state: '服务状态',
      running: '在听',
      stopped: '没在听',
      unknown: '未知',
      url: '地址',
      dir: '站点目录',
      wake: '唤醒并打开',
      probe: '只探活',
      waking: '正在唤醒…',
      open: '在侧边打开',
      reload: '重载',
      openOutside: '外部浏览器',
      failed: '失败：',
      needWake: '服务没在跑，先点「唤醒并打开」',
    };
    const en = {
      entry: 'Material Workbench',
      card: 'Workbench service management',
      hint: 'The workbench is a local static site (it fetches data/*.json), so it needs a local HTTP server; the plugin keeps it running at app start.',
      whereHint: 'Manage the workbench name and URL in the spaces list above. Use the controls below to check and recover the service.',
      state: 'Server',
      running: 'listening',
      stopped: 'down',
      unknown: 'unknown',
      url: 'URL',
      dir: 'Site dir',
      wake: 'Wake & open',
      probe: 'Probe only',
      waking: 'Waking…',
      open: 'Open in sidebar',
      reload: 'Reload',
      openOutside: 'External browser',
      failed: 'Failed: ',
      needWake: 'Server is down — click "Wake & open" first',
    };

    // better-sidebar 属可选依赖。
    let sidecard = null;
    function captureSidecard(ctx) {
      try {
        ctx.inject(['betterSidebar'], (inner) => { sidecard = inner.betterSidebar; });
      } catch (_) {}
    }

    async function callApi(action, method) {
      const res = await fetch(`${API}/${action}`, { method: method || 'GET', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }

    /** 唤醒 + 打开：卡片里的主按钮。 */
    async function wakeAndOpen() {
      const data = await callApi('wake', 'POST');
      if (!data || data.ok !== true) throw new Error((data && data.error) || 'wake failed');
      openUrl(data.url);
      return data;
    }

    function openUrl(url) {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) return false;
      try {
        if (sidecard && typeof sidecard.openTab === 'function') {
          sidecard.openTab({ type: 'browser', url: target, title: '物料录入工作台' });
          return true;
        }
      } catch (_) {}
      try { window.open(target, '_blank'); return true; } catch (_) { return false; }
    }

    function ensureStylesheet() {
      if (document.querySelector('style[data-plugin="dsh-hj-workbench"]')) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-hj-workbench';
      tag.textContent = [
        // —— 设置卡（settings.section）——
        '.hjw-card{display:flex;flex-direction:column;gap:10px;max-width:660px;min-width:0}',
        '.hjw-service-section{margin-top:24px;padding-top:16px;border-top:1px solid var(--dcu-sidebar-border,#ddd)}',
        '.hjw-service-title{margin:0 0 4px;font-size:14px;font-weight:600}',
        '.hjw-service-section .hjw-v{min-width:0;overflow-wrap:anywhere}',
        '.hjw-service-section .hjw-actions{flex-wrap:wrap}',
        '.hjw-hint{font:400 12px/18px var(--dcu-font,inherit);color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit))}',
        '.hjw-row{display:grid;grid-template-columns:88px 1fr;gap:8px;align-items:baseline;font:400 13px/19px var(--dcu-font,inherit)}',
        '.hjw-k{color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit))}',
        '.hjw-v{min-width:0;overflow-wrap:anywhere}',
        '.hjw-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.hjw-btn{padding:6px 12px;border:1px solid var(--dcu-sidebar-border,var(--dcu-border,#ccc));border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
        '.hjw-btn.primary{background:var(--dcu-sidebar-accent,var(--dcu-accent,#5b9dd9));border-color:transparent;color:#fff}',
        '.hjw-btn:disabled{opacity:.6;cursor:progress}',
        '.hjw-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#9aa0a6}',
        '.hjw-dot.up{background:#3fb950}',
        '.hjw-dot.down{background:#d29922}',
        '.hjw-err{font:400 12px/17px var(--dcu-font,inherit);color:#e06c6c}',
        '.hjw-ok{font:400 12px/17px var(--dcu-font,inherit);color:#69b779}',
        // —— 独立 tab（「+」新建菜单里那一类）——
        // 根元素按内置 tab（.subagent / .sidechat）规范写 flex:1 + min-height:0。
        '.hjw-tab{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
        '.hjw-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dcu-sidebar-border,var(--dcu-border,rgba(128,128,128,.2)));font:400 12px/17px var(--dcu-font,inherit);color:var(--dcu-sidebar-secondary,var(--dcu-text-secondary,inherit))}',
        '.hjw-spacer{flex:1 1 auto}',
        '.hjw-frame{flex:1 1 auto;width:100%;min-height:200px;border:0;background:#fff}',
        '.hjw-panel{flex:1 1 auto;display:flex;flex-direction:column;gap:12px;justify-content:center;padding:28px;max-width:660px;margin:0 auto;width:100%;box-sizing:border-box;overflow:auto}',
      ].join('\n');
      document.head.appendChild(tag);
    }

    function WorkbenchIcon(size) {
      const s = size || 16;
      return h('svg', {
        viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z' }),
        h('path', { d: 'M12 12v9' }),
        h('path', { d: 'm4 7.5 8 4.5 8-4.5' }));
    }

    /** 侧边栏内容：注册成独立 tab —— 出现在「+」新建菜单里（自定义空间做不到这个）。 */
    function WorkbenchTab({ t }) {
      const [phase, setPhase] = useState('idle');
      const [url, setUrl] = useState('');
      const [error, setError] = useState('');
      const [reloadKey, setReloadKey] = useState(0);

      const boot = useCallback(async () => {
        setPhase('waking'); setError('');
        try {
          const d = await callApi('wake', 'POST');
          if (!d || d.ok !== true) throw new Error((d && d.error) || 'wake failed');
          setUrl(d.url); setPhase('ready');
        } catch (err) {
          setPhase('error'); setError(String((err && err.message) || err));
        }
      }, []);
      useEffect(() => { void boot(); }, [boot]);

      const openSideTab = () => { if (url) openUrl(url); };
      const openOutside = () => { if (url) { try { window.open(url, '_blank'); } catch (_) {} } };

      if (phase === 'ready' && url) {
        return h('div', { className: 'hjw-tab' },
          h('div', { className: 'hjw-toolbar' },
            h('span', { className: 'hjw-dot up', 'aria-hidden': 'true' }),
            h('span', null, url),
            h('span', { className: 'hjw-spacer' }),
            h('button', { type: 'button', className: 'hjw-btn', onClick: () => setReloadKey((n) => n + 1) }, t('reload')),
            h('button', { type: 'button', className: 'hjw-btn', onClick: openSideTab }, t('open')),
            h('button', { type: 'button', className: 'hjw-btn', onClick: openOutside }, t('openOutside'))),
          h('iframe', { key: reloadKey, className: 'hjw-frame', src: url, title: t('entry') }));
      }
      return h('div', { className: 'hjw-tab' },
        h('div', { className: 'hjw-panel' },
          h('div', { className: 'hjw-hint' }, t('hint')),
          h('div', { className: 'hjw-actions' },
            h('button', { type: 'button', className: 'hjw-btn primary', disabled: phase === 'waking', onClick: boot }, phase === 'waking' ? t('waking') : t('wake')),
            h('button', { type: 'button', className: 'hjw-btn', disabled: !url, onClick: openSideTab }, t('open'))),
          error ? h('div', { className: 'hjw-err' }, t('failed') + error) : null));
    }

    /** 侧边卡片：服务状态 / 手动唤醒 / 只探活（排障用，不是入口）。 */
    function WorkbenchCard({ t }) {
      const [state, setState] = useState('unknown');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [info, setInfo] = useState({ url: '', dir: '', port: '' });
      const refresh = useCallback(() => {
        callApi('status').then((d) => {
          setState(d && d.running ? 'up' : 'down');
          setInfo({ url: (d && d.url) || '', dir: (d && d.dir) || '', port: (d && d.port) || '' });
        }).catch(() => setState('unknown'));
      }, []);
      useEffect(() => { refresh(); }, [refresh]);
      const wake = async () => {
        setBusy(true); setNotice(null);
        try {
          const d = await wakeAndOpen();
          setState('up');
          setInfo({ url: d.url || '', dir: info.dir, port: d.port || info.port });
          setNotice({ kind: 'ok', text: `${t('open')}：${d.url}` });
        } catch (error) {
          setState('down');
          setNotice({ kind: 'err', text: t('failed') + ((error && error.message) || error) });
        } finally { setBusy(false); }
      };
      const label = state === 'up' ? t('running') : state === 'down' ? t('stopped') : t('unknown');
      return h('section', { className: 'hjw-card hjw-service-section', 'aria-label': t('card') },
        h('h3', { className: 'hjw-service-title' }, t('card')),
        h('div', { className: 'hjw-hint' }, t('hint')),
        h('div', { className: 'hjw-hint' }, t('whereHint')),
        h('div', { className: 'hjw-row' },
          h('span', { className: 'hjw-k' }, t('state')),
          h('span', { className: 'hjw-v' }, h('span', { className: `hjw-dot ${state === 'up' ? 'up' : state === 'down' ? 'down' : ''}` }), ' ', label)),
        h('div', { className: 'hjw-row' }, h('span', { className: 'hjw-k' }, t('url')), h('span', { className: 'hjw-v' }, info.url || '—')),
        h('div', { className: 'hjw-row' }, h('span', { className: 'hjw-k' }, t('dir')), h('span', { className: 'hjw-v' }, info.dir || '—')),
        h('div', { className: 'hjw-actions' },
          h('button', { type: 'button', className: 'hjw-btn primary', disabled: busy, onClick: wake }, busy ? t('waking') : t('wake')),
          h('button', { type: 'button', className: 'hjw-btn', disabled: busy, onClick: refresh }, t('probe')),
          h('button', { type: 'button', className: 'hjw-btn', disabled: !info.url, onClick: () => { if (!openUrl(info.url)) setNotice({ kind: 'err', text: t('needWake') }); } }, t('open'))),
        notice ? h('div', { className: notice.kind === 'ok' ? 'hjw-ok' : 'hjw-err' }, notice.text) : null);
    }

    const inject = ['locale', 'slots'];
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hj-workbench: dictionaries');
        const t = ctx.locale.bind(NS);
        ensureStylesheet();
        captureSidecard(ctx);

        // ① 独立 tab（自定义空间做不到）：出现在「+」新建菜单里。
        // 写法对齐本仓库 dsh-sidebar-spaces：ctx.inject(['betterSidebar']) + inner.effect(registerTab)。
        try {
          ctx.inject(['betterSidebar'], (inner) => {
            inner.effect(() => inner.betterSidebar.registerTab({
              id: 'hj-workbench-tab',
              title: () => t('entry'),
              icon: (size) => WorkbenchIcon(size || 16),
              order: 85,
              single: true,
              component: () => h(WorkbenchTab, { t }),
            }), 'dsh-hj-workbench: sidebar tab');
          });
        } catch (error) {
          console.warn('[dsh-hj-workbench] registerTab failed:', error);
        }

        // ② 服务卡归自定义空间的子插槽，不再创建第二个设置导航入口。
        ctx.slots.inject('custom-spaces.services', () => ctx.slots.register({
          name: 'custom-spaces.services',
          id: 'hj-workbench',
          order: 20,
          label: () => t('card'),
          locale: NS,
          inject: () => ({ t }),
        }, WorkbenchCard));
        // ===== 智能体浏览器入口：先查再开，别开一堆（用户 2026-09-21 令）=====
        // 真凶：外壳 browserPanelShow handler 调的是 openBrowser(url, newTab=true) ⇒ 每传一次 url 就新建一个标签。
        // 正确协议（两级，先查全标签清单）：
        //   ① 任何标签已是目标 → 激活它（reused，不新建、不导航）
        //   ② 活动标签是别的页 → 就地导航（navigated，不新建）
        //   ③ 一个标签都没有 → 才新建（created）
        try {
          const bp = () => window.dshDesktopShell?.browserPanel;
          const exec = async (code) => {
            const b = bp();
            if (typeof b?.executeJs !== 'function') return { ok: false, error: 'executeJs 不可用（需重启激活通道）' };
            return await b.executeJs(code);
          };
          const tabs = async (request) => {
            const b = bp();
            if (typeof b?.tabs !== 'function') return { ok: false, error: 'tabs 不可用（需重启激活通道）' };
            return await b.tabs(request ?? { action: 'list' });
          };
          window.__dshAgentBrowser = {
            exec,
            tabs: () => tabs({ action: 'list' }),
            close: (id) => tabs({ action: 'close', id }),
            activate: (id) => tabs({ action: 'activate', id }),
            /** 打开/复用一个页面标签：绝不重复新建。返回 action = reused | reloaded | navigated | created | failed */
            ensure: async (url) => {
              let target = String(url || '').trim();
              if (!target) return { action: 'failed', error: '空 url' };
              // 🔴 地址规范化（2026-09-22 用户报「侧栏面板卡在转圈」的真因）：
              //   相对路径（如 output/xxx.html）交给原生 WebContentsView ⇒ 永远解析不了 ⇒ 空白 + 无限转圈。
              //   规矩：http(s)/file 直通；Windows 绝对路径转成 file:///；**其它相对路径一律明确报错**，
              //   绝不猜 base（猜错就是又一条"看着像加载中"的死页面）。
              if (/^[a-zA-Z]:[\\/]/.test(target) || /^file:\/\//i.test(target)) {
                // 本地文件（盘符路径或 file://）：Chromium **禁止**网页导航到 file://（实测：导航被拦、视图留在原页），
                // 所以改成走本机 HTTP：
                //   ① 工作区根（宏建云系统）下的文件 → 静态服务 http://127.0.0.1:8980/<相对路径>（最稳，已实测可开）
                //   ② 其它路径 → 宿主文件桥 http://127.0.0.1:8975/api/dsh-hj-workbench/file?path=<绝对路径>
                const abs = (/^file:\/\//i.test(target) ? decodeURIComponent(target.replace(/^file:\/\//i, '')) : target).replace(/\\/g, '/');
                const ROOT = 'G:/DSH-3-Portable/宏建云系统';
                if (abs.toLowerCase().startsWith(ROOT.toLowerCase() + '/')) {
                  const rel = abs.slice(ROOT.length + 1).split('/').map((seg) => encodeURIComponent(seg)).join('/');
                  target = 'http://127.0.0.1:8980/' + rel;
                } else {
                  target = 'http://127.0.0.1:8975/api/dsh-hj-workbench/file?path=' + encodeURIComponent(abs);
                }
              } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
                if (!/^https?:/i.test(target)) return { action: 'failed', error: '只接受 http(s):// 地址，收到: ' + target.slice(0, 40) };
              } else {
                return { action: 'failed', error: '需要绝对地址（http(s):// 或盘符绝对路径）；相对路径无法解析，已拒绝交给原生视图' };
              }
              // 同一文档判据：忽略 #锚点 与结尾斜杠（2026-09-21 实测：手册一度开了 3 个重复标签）
              const key = (u) => String(u || '').split('#')[0].replace(/\/+$/, '');
              const match = (u) => key(u) === key(target);
              // 内容活性探针：URL 对 ≠ 页面在（服务器被杀时加载过的标签 URL 正确但文档是死的）
              const alive = async () => {
                const r = await exec("JSON.stringify({href:location.href,rs:document.readyState,len:(document.body?document.body.innerText.length:-1)})");
                if (!r || typeof r !== 'object' || r.ok !== true) return { ok: false, unavailable: true, why: String(r?.error ?? 'exec failed') };
                let d = null;
                try { d = typeof r.result === 'string' ? JSON.parse(r.result) : r.result; } catch (e) { return { ok: false, why: 'unparsable document' }; }
                if (!d || d.href === 'about:blank' || d.href === '') return { ok: false, why: 'about:blank' };
                if (d.rs !== 'complete') return { ok: false, why: 'readyState=' + d.rs };
                if (typeof d.len === 'number' && d.len >= 0 && d.len < 200) return { ok: false, why: 'empty body(' + d.len + ')' };
                return { ok: true, doc: d };
              };
              // ① 全清单查重（忽略 #锚点）：命中就激活；内容已死则就地刷新（reloaded），不做"假复用"
              const list = await tabs({ action: 'list' });
              if (list && list.ok === true && Array.isArray(list.tabs)) {
                const hit = list.tabs.find((tab) => match(tab.url));
                if (hit) {
                  if (hit.active !== true) await tabs({ action: 'activate', id: hit.id });
                  const health = await alive();
                  if (health.ok === true || health.unavailable === true) return { action: 'reused', id: hit.id, url: hit.url, bytes: health.doc?.len };
                  const heal = await exec('location.reload(); "reloading"');
                  let after = health;
                  for (let i = 0; i < 8 && after.ok !== true; i++) { await new Promise((r) => setTimeout(r, 750)); after = await alive(); }
                  return { action: 'reloaded', id: hit.id, url: hit.url, why: health.why, ok: after.ok === true && heal?.ok === true, bytes: after.doc?.len };
                }
              }
              // ② 有活动标签 → 就地导航，不新建；导航后回读确认真的加载出来了再报 ok
              const cur = await exec('location.href');
              if (cur && cur.ok === true) {
                const href = String(cur.result || '');
                if (match(href)) {
                  const health = await alive();
                  if (health.ok === true || health.unavailable === true) return { action: 'reused', href, bytes: health.doc?.len };
                  await exec('location.reload(); "reloading"');
                } else {
                  await exec(`location.href = ${JSON.stringify(target)}; true`);
                }
                let after = { ok: false, why: 'pending' };
                for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 750)); after = await alive(); if (after.ok === true) break; }
                return { action: 'navigated', from: href, to: target, ok: after.ok === true, why: after.ok ? undefined : after.why, bytes: after.doc?.len };
              }
              // ③ 一个标签都没有 → 新建
              if (sidecard && typeof sidecard.openTab === 'function') {
                sidecard.openTab({ type: 'browser', url: target, title: '浏览器' });
                return { action: 'created', url: target };
              }
              return { action: 'failed', error: '无活动标签且 openTab 不可用' };
            },
          };
        } catch (error) {
          console.warn('[dsh-hj-workbench] agent browser helper failed:', error);
        }

        // ===== 浏览器面板生命周期（2026-09-21 硬化）=====
        // 病根：原生面板在主进程、拥有它的卡片在页面里且按会话存在，两边各自维护"可见性"没有握手
        // ⇒ 切会话 / 页面重载 / 收起侧栏 任一条失配，外壳就继续画面板底（白 / 幽灵面板，旧会话内容串到新会话）。
        // 分工（单一权威在主进程）：① 页面只上报它能看到的事实（卡片是否在屏幕上 + 当前活动会话 id）；
        // ② 包装 show 附页面实例令牌，主进程据此拒绝僵尸 renderer 的迟到 IPC；
        // ③ 收起瞬间立即 hide(owner)，不依赖卡片在被隐藏时仍上报 bounds。
        try {
          const BP = window.dshDesktopShell?.browserPanel;
          // contextBridge 暴露的 browserPanel 在 Electron 中被冻结，不能把生命周期标记写在 BP 上。
          if (BP && window.__dshHjBrowserLifecycle !== true) {
            window.__dshHjBrowserLifecycle = true;
            const PAGE_TOKEN = 'page-' + Math.random().toString(36).slice(2, 10);
            let lease = null;
            const origShow = BP.show.bind(BP);
            const origHide = BP.hide.bind(BP);
            if (!Object.isFrozen(BP)) {
              BP.show = (request) => {
                try { if (request && typeof request.owner === 'string') lease = request.owner; } catch (e) {}
                // 附上**调用方所属会话**：外壳据此只让当前会话打开面板（用户 2026-09-21 令「别的会话不要自动给我开面板」）
                let sid = undefined;
                try { sid = activeSession(); } catch (e) {}
                return origShow(Object.assign({}, request, { pageToken: PAGE_TOKEN }, sid === undefined ? {} : { sessionId: sid }));
              };
              BP.hide = (owner) => { try { if (owner === lease) lease = null; } catch (e) {} return origHide(owner); };
            }
            const cardState = () => {
              // 🔴 判据不能绑"宿主 div 的像素尺寸/可见性"：原生面板尚未显示时宿主可能是 0 尺寸或被隐藏，
              // 那会把"用户想打开"误判成 absent ⇒ 外壳门禁永远不许显示（2026-09-21 实测：浏览器打不开）。
              // 正解：只要侧栏里确实开着 browser 卡片（宿主在 DOM 里 / 标签清单里有 browser 类型）就算"该显示"；
              // 只有**确实没有卡片**时才报 absent（那才是"切到没有浏览器的会话"这一合法撤销场景）。
              const el = document.querySelector('[data-native-browser-card]');
              if (el !== null) {
                if (el.getClientRects().length === 0) return 'hidden';
                const r = el.getBoundingClientRect();
                return r.width > 8 && r.height > 8 ? 'visible' : 'hidden';
              }
              try {
                const cards = window.__dshAgentSidebar?.openTabs?.() || [];
                if (cards.some((t) => t && t.type === 'browser')) return 'visible';
              } catch (e) {}
              return 'absent';
            };
            const activeSession = () => {
              const el = document.querySelector('[data-dcu-session][aria-selected="true"]')
                || document.querySelector('.dcu-wb-session.dcu-wb-selected[data-dcu-session]');
              return el === null ? undefined : (el.getAttribute('data-dcu-session') || undefined);
            };
            const hideNow = () => {
              try {
                if (cardState() === 'visible') return;
                if (lease !== null) { const owner = lease; lease = null; void origHide(owner).catch(() => {}); return; }
                void Promise.resolve(BP.tabs({ action: 'list' }))
                  .then((r) => {
                    // tabs() 异步返回前卡片可能已经重新挂载；绝不能用旧的“隐藏”决定收掉新 owner。
                    if (cardState() === 'visible') return undefined;
                    if (r && typeof r.owner === 'string' && r.owner) return origHide(r.owner);
                    return undefined;
                  })
                  .catch(() => {});
              } catch (e) {}
            };
            const push = () => {
              try {
                const state = cardState();
                // 会话身份恢复上报（外壳的换桶已修：首次信号只认领不清空）⇒ 支撑"只有当前会话能开面板"与按会话分桶
                window.dshDesktopShell?.reportState?.({ browserPanelCard: state, activeSessionId: activeSession() });
                if (state !== 'visible') hideNow();
              } catch (e) {}
            };
            push();
            setInterval(push, 1000);
            // 🩹 自愈（2026-09-22，用户报「面板卡在转圈」）：地址**没有 scheme** 的标签（如 output/xxx.html）
            //    原生视图永远解析不了 ⇒ 空白+转圈。发现即关掉，不让僵尸标签占着面板；
            //    调用方用绝对地址（http(s):// 或 file:/// 或盘符路径）重开即可。
            setInterval(async () => {
              try {
                const list = await BP.tabs({ action: 'list' });
                const tabs = (list && list.tabs) || [];
                // ① 外壳记录里就没有 scheme 的标签（存了原始相对地址）
                for (const tab of tabs) {
                  const tabUrl = String(tab.url || '');
                  if (tabUrl !== '' && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(tabUrl) === false) {
                    console.warn('[dsh-hj-workbench] 关闭僵尸标签（无 scheme 地址）:', tabUrl.slice(0, 80));
                    await BP.tabs({ action: 'close', id: tab.id });
                  }
                }
                // ② 记录看着正常、但**视图真实地址**是 Chromium 错误页 / about:blank ⇒ 同样是
                //    "看着像加载中"的死页面（2026-09-22 实测：相对路径开文件后外壳说"已打开"，视图其实在
                //    chrome-error://chromewebdata/）。判据必须看视图本身，不能只看外壳记录。
                const probe = await BP.executeJs('location.href');
                const real = probe && typeof probe.result === 'string' ? probe.result : '';
                if (/^chrome-error:\/\//.test(real) || real === 'about:blank') {
                  const dead = tabs.find((t) => t.active === true) || tabs[0];
                  if (dead) {
                    console.warn('[dsh-hj-workbench] 关闭打不开的标签（视图停在错误页）:', real.slice(0, 60));
                    await BP.tabs({ action: 'close', id: dead.id });
                  }
                }
              } catch (e) {}
            }, 5000);
            try {
              const observer = new MutationObserver(() => { try { if (cardState() !== 'visible') hideNow(); } catch (e) {} });
              observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
            } catch (e) {}
          }
        } catch (error) {
          console.warn('[dsh-hj-workbench] browser panel lifecycle failed:', error);
        }

        // ===== 智能体侧边栏入口：覆盖全部板块（用户 2026-09-21 令）=====
        // 除 browser 是原生 WebContentsView（走 __dshAgentBrowser），其余 12 个板块都在 DSH 页面里渲染 HTML
        // ⇒ 用 better-sidebar 服务 API 开关标签 + 用 DOM 操作内容（作用域锁定到「可见的那个标签内容」，
        //   避免误命中隐藏标签里的同名元素）。
        try {
          const svc = () => sidecard;
          const visible = (el) => el.getClientRects().length > 0;
          const collectTabs = (node, acc) => {
            if (!node || typeof node !== 'object') return acc;
            if (Array.isArray(node.tabs)) for (const tab of node.tabs) acc.push(tab);
            if (node.kind === 'split' || Array.isArray(node.children)) for (const child of node.children || []) collectTabs(child, acc);
            return acc;
          };
          /** 可见面板里「当前活动标签」的内容根。
           *  选 pane 的规则（实测教训）：不能取最后一个 —— 底部面板 pane:3 也报"可见"但内容为空。
           *  正解：优先选「含可见标签内容」的 pane，其次按面积最大者。
           *  三重兜底：可见的标签内容 → 可见的内容容器 → 面板本身（terminal 等 canvas 面板 innerText 为空属正常）。 */
          const paneRoot = () => {
            const panes = [...document.querySelectorAll('[data-dsh-pane]')].filter(visible);
            if (!panes.length) return null;
            const withTabs = panes.filter((p) => [...p.querySelectorAll('[class*="paneTab"]')].some(visible));
            const pool = withTabs.length ? withTabs : panes;
            const pane = pool.reduce((best, cur) => {
              const a = best.getBoundingClientRect(), b = cur.getBoundingClientRect();
              return b.width * b.height > a.width * a.height ? cur : best;
            });
            const tabs = [...pane.querySelectorAll('[class*="paneTab"]')].filter(visible);
            if (tabs.length) return tabs[tabs.length - 1];
            const contents = [...pane.querySelectorAll('[class*="paneContent"]')].filter(visible);
            if (contents.length) return contents[contents.length - 1];
            return pane;
          };
          const root = (sel) => { const p = paneRoot(); return p ? p.querySelector(sel) : null };
          const setValue = (el, value) => {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, value); else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          window.__dshAgentSidebar = {
            service: () => svc(),
            types: () => svc()?.getTabs?.().map((tab) => tab.id) ?? [],
            state: () => svc()?.getSnapshot?.()?.state ?? null,
            openTabs: () => collectTabs(svc()?.getSnapshot?.()?.state?.splits, []),
            open: (seed) => svc()?.openTab?.(seed),
            activate: (id) => svc()?.activateTab?.(id),
            close: (id) => svc()?.closeTab?.(id),
            update: (id, patch) => svc()?.updateTab?.(id, patch),
            openFile: (path) => svc()?.openFile?.(path),
            show: (open) => svc()?.setPanelOpen?.(open === undefined ? true : open),
            pane: paneRoot,
            text: () => paneRoot()?.innerText ?? null,
            q: (sel) => root(sel),
            qa: (sel) => { const p = paneRoot(); return p ? [...p.querySelectorAll(sel)] : [] },
            click: (sel) => { const el = root(sel); if (!el) return { ok: false, error: 'not found: ' + sel }; el.click(); return { ok: true } },
            type: (sel, value) => { const el = root(sel); if (!el) return { ok: false, error: 'not found: ' + sel }; setValue(el, value); return { ok: true, value: el.value } },
            read: (sel) => { const el = root(sel); return el ? (el.value !== undefined && el.value !== null && el.tagName !== 'DIV' ? el.value : el.innerText) : null },
            findByText: (text, tag) => {
              const p = paneRoot();
              if (!p) return null;
              const nodes = [...p.querySelectorAll(tag || 'button,a,[role="button"],[role="tab"],[role="treeitem"],li,tr')];
              return nodes.find((el) => visible(el) && (el.innerText || '').trim().includes(text)) || null;
            },
            clickText: (text, tag) => { const el = window.__dshAgentSidebar.findByText(text, tag); if (!el) return { ok: false, error: 'no match: ' + text }; el.click(); return { ok: true, tag: el.tagName } },
          };
        } catch (error) {
          console.warn('[dsh-hj-workbench] agent sidebar helper failed:', error);
        }

        // ===== 共享探针通道：broker 取指令 → 按 kind 执行 → 回传（2026-09-21）=====
        // 配套 宏建云系统/tools/hj_probe_broker.py（127.0.0.1:8976，令牌 hj-probe-2026）+ hj_probe.py。
        // 🔴 这条通道是**给所有会话共用的**（用户 2026-09-21 批评「就你这个会话可以，其他会话不能用」）：
        //    别的会话只能对"浏览器标签"下指令，拿不到"页面侧助手"，所以 kind 必须覆盖页面侧：
        //      kind=tab   （默认）在当前活动标签里执行 JS        —— 旧行为，向后兼容
        //      kind=page  在 **DSH 页面里**执行 JS（可调 __dshAgentBrowser / __dshAgentSidebar）
        //      kind=tabs  标签管理 {action:'list'|'activate'|'close', target?}
        //      kind=codex 召唤 Codex：{question} ⇒ 挑草稿标签 → 打开 ChatGPT → 提问 → 等**新的一条**回答 → 读回
        //    🔴 所有 kind 都过同一份「重启/退出」护栏；字面量拆开拼，避免误触 bundle 扫描用例。
        try {
          const BROKER = 'http://127.0.0.1:8976';
          const BROKER_TOKEN = 'hj-probe-2026';
          const RESTART_WORD = 'app-' + 'restart';
          const QUIT_WORD = 'app-' + 'quit';
          const FORBIDDEN = new RegExp(`${RESTART_WORD}|${QUIT_WORD}|dshDesktopShell\\.action\\(\\s*['"](?:${RESTART_WORD}|${QUIT_WORD})['"]`);
          const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
          const runInPage = (code) => {
            let fn = null;
            try { fn = new Function('return (async () => { ' + code + ' })()'); } catch (e) { return Promise.reject(new Error('编译失败: ' + e)); }
            return Promise.resolve(fn());
          };
          /** 召唤 Codex（任一会话可用）：判读必须等"助手消息条数增加"后再等长度稳定 —— 不能读旧回答 */
          const askCodex = async (question) => {
            const ab = window.__dshAgentBrowser;
            if (!ab) return { ok: false, error: 'no __dshAgentBrowser' };
            const bp = window.dshDesktopShell?.browserPanel;
            const isDisposable = (u) => !/127\.0\.0\.1:8765|hongjian\.com|chatgpt\.com/.test(String(u));
            let tabs = ((await ab.tabs()).tabs) || [];
            let gpt = tabs.find((t) => String(t.url).includes('chatgpt.com'));
            let how = 'reused';
            if (gpt === undefined) {
              // ② 没有 ChatGPT 标签 → 用外壳**新建一个**（绝不拿正在看的页面就地导航：那会把用户的手册/ERP 顶掉）
              const owner = ((await ab.tabs()).owner) || null;
              if (bp && typeof bp.show === 'function' && owner !== null) {
                try { await bp.show({ owner, url: 'https://chatgpt.com/' }); } catch (e) {}
                await sleepMs(1800);
                tabs = ((await ab.tabs()).tabs) || [];
                gpt = tabs.find((t) => String(t.url).includes('chatgpt.com'));
                how = 'created';
              }
              if (gpt === undefined) {
                // ③ 兜底：挑一个"可牺牲"的标签（不是手册/ERP/ChatGPT）就地导航；都没有才动活动标签
                const spare = tabs.find((t) => t.active !== true && isDisposable(t.url))
                  || tabs.find((t) => isDisposable(t.url)) || null;
                if (spare !== null) await ab.activate(spare.id);
                await ab.ensure('https://chatgpt.com/');
                await sleepMs(1800);
                gpt = (((await ab.tabs()).tabs) || []).find((t) => String(t.url).includes('chatgpt.com'));
                how = how === 'created' ? 'created' : 'nav-spare';
              }
            }
            if (gpt !== undefined && gpt.active !== true) await ab.activate(gpt.id);
            await sleepMs(6000);
            const ensured = how;
            const composer = (await ab.exec("(() => { const b = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable=\"true\"]'); return b ? 'ok' : 'none'; })()"))?.result;
            if (composer !== 'ok') return { ok: false, error: 'ChatGPT 输入框不可用（可能未登录）', ensured };
            const countBefore = Number((await ab.exec("document.querySelectorAll('[data-message-author-role=\"assistant\"]').length"))?.result) || 0;
            await ab.exec("(() => { const b = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable=\"true\"]'); b.focus(); document.execCommand('insertText', false, " + JSON.stringify(String(question)) + "); return true; })()");
            await sleepMs(900);
            const sent = (await ab.exec("(() => { const btn = document.querySelector('#composer-submit-button') || document.querySelector('button[data-testid=\"send-button\"]'); if (!btn) return 'no-send'; btn.click(); return 'clicked'; })()"))?.result;
            if (sent !== 'clicked') return { ok: false, error: '发送按钮不可用' };
            const gptNow = ((await ab.tabs()).tabs || []).find((t) => String(t.url).includes('chatgpt.com'));
            if (!gptNow) return { ok: false, error: 'chatgpt 标签丢失' };
            let prev = -1;
            let stable = 0;
            let text = '';
            for (let i = 0; i < 60; i++) {
              await sleepMs(4000);
              const act = (await ab.tabs()).tabs.find((t) => t.active === true);
              if (act && String(act.url).includes('chatgpt.com') === false) await ab.activate(gptNow.id);
              const r = await ab.exec("(() => { const ms = document.querySelectorAll('[data-message-author-role=\"assistant\"]'); const last = ms.length ? ms[ms.length - 1].innerText : ''; return JSON.stringify({ n: ms.length, len: last.length, text: last }); })()");
              let d = null;
              try { d = typeof r?.result === 'string' ? JSON.parse(r.result) : r?.result; } catch (e) {}
              if (!d || d.n <= countBefore) continue; // 还没出现**新**回答 ⇒ 绝不读旧的（2026-09-21 踩过）
              if (d.len === prev && d.len > 100) stable++; else stable = 0;
              prev = d.len;
              text = d.text;
              if (stable >= 1) return { ok: true, answer: text, chars: text.length, priorMessages: countBefore };
            }
            return { ok: false, error: '等待回答超时', partial: String(text).slice(0, 200) };
          };
          // 🔴 用"带上限的忙标记"而不是布尔量：一条命令卡住（原生视图无响应等）时，
          //   布尔量会让轮询器**永久不再取指令**（2026-09-22 实测：30s 无回传、队列空、broker 在听 ✗）。
          let busyUntil = 0;
          setInterval(async () => {
            if (Date.now() < busyUntil) return
            busyUntil = Date.now() + 25000
            try {
              const res = await fetch(`${BROKER}/next?t=${BROKER_TOKEN}`, { cache: 'no-store' });
              const job = await res.json();
              if (job && typeof job === 'object' && (typeof job.code === 'string' || typeof job.question === 'string')) {
                const kind = typeof job.kind === 'string' ? job.kind : 'tab';
                const code = String(job.code ?? '');
                let out = { id: job.id, ok: false };
                try {
                  if (kind === 'codex') {
                    out = Object.assign({ id: job.id }, await askCodex(job.question ?? code));
                  } else if (kind === 'page') {
                    if (FORBIDDEN.test(code)) out = { id: job.id, ok: false, error: 'blocked: 禁止重启/退出动作' };
                    else { const r = await runInPage(code); out = { id: job.id, ok: true, result: r === undefined ? null : r }; }
                  } else if (kind === 'tabs') {
                    const ab = window.__dshAgentBrowser;
                    const action = job.action ?? 'list';
                    const r = action === 'activate' ? await ab.activate(job.target) : action === 'close' ? await ab.close(job.target) : await ab.tabs();
                    out = { id: job.id, ok: true, result: r };
                  } else {
                    if (FORBIDDEN.test(code)) out = { id: job.id, ok: false, error: 'blocked: 客户端 bundle 禁止重启/退出动作' };
                    else { const r = await window.__dshAgentBrowser?.exec?.(code); out = { id: job.id, ok: r?.ok === true, result: r?.result ?? null, error: r?.error ?? null }; }
                  }
                } catch (e) { out = { id: job.id, ok: false, error: String(e) }; }
                await fetch(`${BROKER}/result?t=${BROKER_TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) }).catch(() => {});
              }
            } catch (e) { /* broker 没起就下次再试 */ } finally { busyUntil = 0 }
          }, 1200);
        } catch (error) {
          console.warn('[dsh-hj-workbench] probe broker poller failed:', error);
        }

      } catch (error) {
        console.warn('[dsh-hj-workbench] apply failed:', error);
      }
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
