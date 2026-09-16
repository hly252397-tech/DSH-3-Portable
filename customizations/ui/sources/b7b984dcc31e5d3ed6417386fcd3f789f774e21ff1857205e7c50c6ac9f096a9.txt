import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('Data/DSH/profiles/web/local/dsh-better-sidebar');
const path = resolve(root, 'lib/client.js');
let bundle = readFileSync(path, 'utf8');
if (!bundle.includes('existingBrowser = inputTabs.find')) {
  bundle = bundle.replace('let landed = next;', `let landed = next;
      if (seed.url !== void 0 && !isCreation && tab.type === "browser") {
        const existingBrowser = inputTabs.find(candidate => candidate.type === "browser");
        if (existingBrowser) landed = patchTab(next, existingBrowser.id, {
          path: seed.url,
          meta: { ...existingBrowser.meta, nativeBrowserNavigationId: crypto.randomUUID() },
        });
      }`);
  assert.ok(bundle.includes('existingBrowser = inputTabs.find'), 'upstream browser URL landing changed');
}
const factory = readFileSync(resolve(root, 'portable/browser-view.js'), 'utf8').replace('export function ', 'function ');
const start = bundle.indexOf('\t\t//#region src/client/BrowserView.tsx');
const end = bundle.indexOf('\t\t//#endregion', start);
assert.ok(start > 0 && end > start, 'upstream BrowserView boundary changed');
bundle = bundle.slice(0, start) + '\t\t//#region src/client/BrowserView.tsx\n' + factory + '\nconst BrowserView = createNativeBrowserView(react, t);\n' + bundle.slice(end);
for (const key of ['browserNoSandbox', 'browserAllowedLoopback']) {
  // Remove only this browser descriptor's obsolete iframe settings, not stored user data.
  const descriptor = bundle.indexOf('id: "browser",', bundle.indexOf('function builtinTabs'));
  const from = bundle.indexOf(`\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tkey: "${key}"`, descriptor);
  if (from >= 0) {
    const to = bundle.indexOf('\n\t\t\t\t\t\t}', from) + '\n\t\t\t\t\t\t}'.length;
    bundle = bundle.slice(0, from) + bundle.slice(to + (bundle[to] === ',' ? 1 : 0));
  }
}
const dictionary = [
  ['browser: "浏览器",', 'nativeBrowserUnavailable: "请更新并重启 DSH 桌面以使用内置浏览器。", nativeBrowserRetry: "重试",'],
  ['browser: "Browser",', 'nativeBrowserUnavailable: "Update and restart DSH Desktop to use its built-in browser.", nativeBrowserRetry: "Retry",'],
];
bundle = bundle.replace(/id: "browser",(?! single: true,)/, 'id: "browser", single: true,');
for (const [needle, fields] of dictionary) {
  // English also occurs in other language dictionaries; only one fallback is required.
  if (!bundle.includes(fields)) bundle = bundle.replaceAll(needle, needle + fields);
}
for (const [needle, fields] of [
  ['nativeBrowserRetry: "重试",', 'nativeBrowserTooSmall: "请拖大浏览器卡片，至少需要 280 × 240 的显示区域。",'],
  ['nativeBrowserRetry: "Retry",', 'nativeBrowserTooSmall: "Enlarge the browser card to at least 280 × 240.",'],
]) {
  if (!bundle.includes(fields)) bundle = bundle.replaceAll(needle, needle + fields);
}
writeFileSync(path, bundle);
console.log('Native browser card client generated');
