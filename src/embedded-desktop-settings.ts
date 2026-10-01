/** Fixed capabilities shared by the embedded document and the main-process dispatcher. */
export const DESKTOP_SETTINGS_METHODS = [
  'getBootstrap', 'getNotificationPreferences', 'updateNotificationPreferences',
  'updateThemePreferences', 'getUpdatePreferences', 'updateUpdatePreferences',
  'getDesktopUpdateState', 'desktopUpdateAction', 'getHarnessUpdateState',
  'updateHarnessUpdatePolicy', 'harnessUpdateAction',
] as const

export function mayUseEmbeddedDesktopSettings(kind: string, mainFrame: boolean, url: string, origin: string | undefined): boolean {
  if (kind !== 'dsh' || !mainFrame || origin === undefined) return false
  try { return new URL(url).origin === origin && new URL(url).protocol === 'http:' }
  catch { return false }
}

export function parseDesktopSettingsRequest(value: unknown): { method: string; value?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid desktop settings request')
  const request = value as Record<string, unknown>
  if (Object.keys(request).some(key => key !== 'method' && key !== 'value')
    || typeof request.method !== 'string'
    || !(DESKTOP_SETTINGS_METHODS as readonly string[]).includes(request.method)) throw new Error('Unknown desktop settings method')
  return { method: request.method, value: request.value }
}

export function embeddedDesktopSettingsDocument(html: string, css: string, theme: string, chevron: string): string {
  // No disk URLs or network requests escape into the sandbox. Both presentations
  // run the SAME settings script; only the transport and responsive layout differ.
  const shim = `(() => {
    const channel='dsh-desktop-settings-v1', pending=new Map(), listeners=new Map(); let sequence=0;
    function request(method,value){return new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Desktop settings request timed out'));},600000);
      pending.set(id,{resolve,reject,timer}); parent.postMessage({channel,id,method,value},'*');
    });}
    function subscribe(event,callback){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(callback);return()=>listeners.get(event).delete(callback);}
    function themeBootstrap(value){if(!value)return;document.documentElement.dataset.colorScheme=value.colorScheme;
      if(value.themePreset)document.documentElement.dataset.dshPreset=value.themePreset;}
    addEventListener('message',event=>{
      if(event.source!==parent||event.data?.channel!==channel)return;const data=event.data;
      if(data.event){if(data.event==='bootstrap')themeBootstrap(data.value);for(const callback of listeners.get(data.event)||[])callback(data.value);return;}
      const item=pending.get(data.id);if(!item)return;pending.delete(data.id);clearTimeout(item.timer);
      if(data.error)item.reject(new Error(data.error));else item.resolve(data.value);
    });
    const api={};for(const method of ${JSON.stringify(DESKTOP_SETTINGS_METHODS)})api[method]=value=>request(method,value);
    api.getBootstrap=()=>request('getBootstrap').then(value=>{themeBootstrap(value);return value;});
    for(const [method,event] of Object.entries({onBootstrap:'bootstrap',onDesktopUpdateState:'desktopUpdateState',onHarnessUpdateState:'harnessUpdateState',onSettingsSection:'settingsSection'}))api[method]=callback=>subscribe(event,callback);
    api.closeDesktopSettings=()=>request('close');window.dshShell=api;
  })();`
  const script = (source: string): string => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`
  return html
    .replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${script(shim)}`)
    .replace('<link rel="stylesheet" href="theme.css">', `<style>${css}</style>`)
    .replace('<script src="theme.js"></script>', script(theme))
    .replaceAll('src="./shell-icons/chevron-down.svg"', `src="data:image/svg+xml;base64,${Buffer.from(chevron).toString('base64')}"`)
    .replace('</head>', `<style>
      body{display:flex;flex-direction:column}aside{display:flex;flex-wrap:wrap;gap:4px;padding:8px;border-right:0;border-bottom:1px solid var(--chrome-border)}
      aside .eyebrow{display:none}aside .nav-item{width:auto;flex:0 1 auto}main{min-height:0;flex:1;padding:20px}h1{font-size:22px}
      .row{min-width:0}.value,.update-feedback{overflow-wrap:anywhere}
      @media(max-width:420px){main{padding:12px}.row{grid-template-columns:1fr}}
    </style></head>`)
}
