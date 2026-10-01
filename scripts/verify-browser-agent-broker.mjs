import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.env.DSH_PORTABLE_ROOT || 'G:/DSH-3-Portable'
const python = process.env.DSH_PYTHON || `${root}/宏建云系统/python/base/python.exe`
const script = `${root}/宏建云系统/tools/browser_agent_broker.py`
const port = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port
    probe.close((error) => error ? reject(error) : resolve(value))
  })
})
const tokenFile = join(tmpdir(), `dsh-browser-agent-${process.pid}.json`)
const child = spawn(python, [script, '--port', String(port), '--token-file', tokenFile], {
  stdio: 'ignore', windowsHide: true, cwd: root,
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const request = async (url, options = {}) => {
  const response = await fetch(url, options)
  return { status: response.status, body: await response.json() }
}

try {
  let descriptor
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(tokenFile)) {
      descriptor = JSON.parse(readFileSync(tokenFile, 'utf8'))
      try { if ((await request(`http://127.0.0.1:${port}/health`)).body.ok) break } catch { /* starting */ }
    }
    await wait(100)
  }
  assert.equal(descriptor?.protocol, 1)
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: `Bearer ${descriptor.token}` }
  const rejected = await request(`${base}/v1/requests`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 1, sessionId: 's1', action: 'read_page', args: { code: 'new Function()' } }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'args_unknown')
  const created = await request(`${base}/v1/requests`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 1, sessionId: 's1', action: 'open_or_focus', args: { url: 'https://chatgpt.com/c/test' } }),
  })
  assert.equal(created.status, 202)
  const id = created.body.id
  assert.equal((await request(`${base}/v1/next?sessionId=s2`)).body.request, null)
  const claimed = await request(`${base}/v1/next?sessionId=s1`)
  assert.equal(claimed.body.request.id, id)
  const returned = await request(`${base}/v1/results/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Browser-Poll': '1' },
    body: JSON.stringify({ sessionId: 's1', ok: true, result: { ok: true } }),
  })
  assert.equal(returned.status, 200)
  const finished = await request(`${base}/v1/requests/${id}`, { headers: auth })
  assert.equal(finished.body.state, 'completed')
  console.log('browser-agent-broker PASS: auth, action schema, session routing, result completion')
} finally {
  try { child.kill() } catch { /* already exited */ }
  await wait(100)
  try { if (existsSync(tokenFile)) rmSync(tokenFile, { force: true }) } catch { /* best effort temp cleanup */ }
}
