import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_PORTABLE_ROOT || 'G:/DSH-3-Portable'
const policy = await import(pathToFileURL(`${root}/Data/DSH/profiles/web/local/dsh-browser-agent-tools/lib/policy.js`))

assert.equal(policy.validateOperation('open_or_focus', { url: 'https://chatgpt.com/c/1' }).ok, true)
assert.equal(policy.validateOperation('open_or_focus', { url: 'https://evil.example/c/1' }).code, 'url_not_allowed')
assert.equal(policy.validateOperation('open_or_focus', { url: 'javascript:alert(1)' }).code, 'url_not_allowed')
assert.equal(policy.validateOperation('read_page', { code: 'document.body.innerText' }).code, 'args_unknown')
assert.equal(policy.validateOperation('list_tabs', { code: 'new Function()' }).code, 'args_unknown')
assert.equal(policy.validateOperation('chatgpt_inspect', { tabId: 'tab-1', maxChars: 9000 }).ok, true)
assert.equal(policy.boundedTextLimit(999999), 65536)

const client = await fs.readFile(`${root}/Data/DSH/profiles/web/local/dsh-hj-workbench/lib/client.js`, 'utf8')
const safeStart = client.indexOf('// ===== 受控浏览器工具通道（P1）=====')
const oldStart = client.indexOf('// ===== 共享探针通道：broker 取指令', safeStart)
assert.ok(safeStart >= 0 && oldStart > safeStart)
const safeBlock = client.slice(safeStart, oldStart)
assert.equal(safeBlock.includes('new Function('), false)
assert.equal(safeBlock.includes('/v1/next?sessionId=${'), true)
assert.equal(safeBlock.includes('request.action'), true)

console.log('browser-agent-policy PASS: URL allowlist, unknown-field rejection, bounded output, structured client path')
