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
const embeddedSource = readFileSync(resolve(root, 'portable/embedded-browser-view.js'), 'utf8');
assert.ok(embeddedSource.includes("document.createElement('webview')"), 'embedded browser must create DOM-owned webviews');
assert.ok(embeddedSource.includes("data-embedded-browser-card"), 'embedded browser must own a distinct card surface');
const embeddedFactory = embeddedSource.replace('export function ', 'function ');
const start = bundle.indexOf('\t\t//#region src/client/BrowserView.tsx');
const end = bundle.indexOf('\t\t//#endregion', start);
assert.ok(start > 0 && end > start, 'upstream BrowserView boundary changed');
bundle = bundle.slice(0, start) + '\t\t//#region src/client/BrowserView.tsx\n' + embeddedFactory + `
const EmbeddedBrowserView = createEmbeddedBrowserView(react, t);
function BrowserView(props) {
  return react.createElement(EmbeddedBrowserView, props);
}
` + bundle.slice(end);
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
// 互斥补丁（2026-09-23 用户令「直接移除/防下次构建又出现」）：
// 文件预览/编辑器上屏时必须收掉原生 WebContentsView（它永远在 HTML 之上）。
// 这些补丁必须随每次 build-native-browser-card 重放，否则上游 bundle 重建会把它们冲掉。
if (!bundle.includes('browserPanel?.hide?.(); } catch {}')) {
  const openSidebarNeedle = 'const title = at === -1 ? absolute : absolute.slice(at + 1);\n\t\t\tctx.get("betterSidebar")?.openTab({';
  if (bundle.includes(openSidebarNeedle)) {
    bundle = bundle.replace(
      openSidebarNeedle,
      'const title = at === -1 ? absolute : absolute.slice(at + 1);\n\t\t\ttry { window.dshDesktopShell?.browserPanel?.hide?.(); } catch {}\n\t\t\tctx.get("betterSidebar")?.openTab({',
    );
  }
}
if (!bundle.includes('文件预览/编辑器与原生浏览器互斥')) {
  const editorNeedle = 'const [reloadSeq, setReloadSeq] = (0, react.useState)(0);\n\t\t\tconst refreshFile = () => {';
  if (bundle.includes(editorNeedle)) {
    bundle = bundle.replace(
      editorNeedle,
      'const [reloadSeq, setReloadSeq] = (0, react.useState)(0);\n\t\t\t// 文件预览/编辑器与原生浏览器互斥：WebContentsView 永远在 HTML 之上。\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (path === "" || isDir) return;\n\t\t\t\ttry { window.dshDesktopShell?.browserPanel?.hide?.(); } catch {}\n\t\t\t}, [path, isDir]);\n\t\t\tconst refreshFile = () => {',
    );
  }
}
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex < 0 ? path : resolve(process.argv[outputIndex + 1]);
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--output requires a path');
writeFileSync(outputPath, bundle);
console.log(`Browser card client generated: ${outputPath}`);
