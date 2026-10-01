// Diagnose header squeeze with real viewport via headless Edge + CDP.
// Usage: node scripts/diag-headless-edge.mjs <url> <shotPath> <jsFile>
// Navigates, evaluates the async IIFE in jsFile (returnByValue), screenshots.
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const [url, shotPath, jsFile] = process.argv.slice(2);
const userDataDir = 'Data/Temp/diag-edge-profile';
rmSync(userDataDir, { recursive: true, force: true });

const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--disable-extensions',
  '--window-size=1500,950',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

process.on('exit', () => { try { edge.kill(); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getBrowserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      return j.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('devtools endpoint never came up');
}

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        }
      };
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const browserWs = await getBrowserWs();
const cdp = new CDP(browserWs);
await cdp.open();
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = sessionId;

await cdp.send('Page.enable', {}, S);
await cdp.send('Runtime.enable', {}, S);
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1500, height: 950, deviceScaleFactor: 1, mobile: false,
}, S);
await cdp.send('Page.navigate', { url }, S);
await sleep(10000); // let DSH web boot

const expr = readFileSync(jsFile, 'utf8');
const evalRes = await cdp.send('Runtime.evaluate', {
  expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000,
}, S);
console.log('EVAL_RESULT:', JSON.stringify(evalRes.result, null, 2));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
console.log('SHOT_SAVED:', shotPath);

cdp.ws.close();
try { edge.kill(); } catch {}
await sleep(500);
process.exit(0);
