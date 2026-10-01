// The single place that talks to an external Agent Bridge.
//
// Credential rule: the Bridge admin token is read here, per request, and never
// returned to the browser. The Bridge rotates that file on every start, so a
// cached copy is a stale copy. No export in this module yields a token.
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const SERVICE = 'agent-bridge'
const PROBE_TIMEOUT_MS = 1500
const CALL_TIMEOUT_MS = 8000
const STOP_TIMEOUT_MS = 8000
const STOP_HELPER_TIMEOUT_MS = 5000
const STOP_HELPER_EXIT_MS = 1500
// A squatter on the port is reported, never replaced: killing or displacing a
// process this plugin did not create is exactly the failure mode to avoid.
const OWNERSHIP_FILE = 'agent-bridge-ownership.json'

// Live children this process actually spawned. A handle is required to stop:
// after a DSH restart the entry is gone, so the Bridge is treated as external.
const children = new Map()

export function bridgeHome() {
  return process.env.DSH_HOME || process.cwd()
}

async function callJson(port, path, { method = 'GET', body, token, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bad port')
  const signal = AbortSignal.timeout(timeoutMs)
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, signal, redirect: 'error',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`Bridge ${path} returned non-JSON (HTTP ${response.status})`) }
  if (!response.ok) throw new Error(`Bridge ${path} HTTP ${response.status} ${parsed.error_code || ''}`.trim())
  return parsed
}

/** Identify whatever answers on the port. A TCP connect alone is not proof. */
export async function probeBridge(port) {
  try {
    const health = await callJson(port, '/health', { timeoutMs: PROBE_TIMEOUT_MS })
    if (health?.service === SERVICE) return { online: true, service: SERVICE, instances: Number(health.instances) || 0 }
    return { online: false, reason: 'PORT_NOT_BRIDGE' }
  } catch (error) {
    // A reachable port that answers something else must never be adopted.
    if (/HTTP \d+|non-JSON/.test(error.message)) return { online: false, reason: 'PORT_NOT_BRIDGE' }
    return { online: false, reason: 'UNREACHABLE' }
  }
}

function readAdminToken(bridgeDir) {
  try {
    const token = readFileSync(join(bridgeDir, 'data', 'admin.token'), 'utf8').trim()
    return token || null
  } catch { return null }
}

const str = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '')

/** Whitelist trim: unknown Bridge fields are dropped rather than forwarded. */
function trimRun(run) {
  return {
    run_id: str(run?.run_id, 64),
    task_id: str(run?.task_id, 64),
    agent_id: str(run?.agent_id, 64),
    workspace_id: str(run?.workspace_id, 64),
    state: str(run?.state, 32),
    dispatch_state: str(run?.dispatch_state, 32),
    native_session_id: str(run?.native_session_id, 64),
    // The result body can contain an agent's whole transcript; keep it a verdict.
    verified: typeof run?.result === 'string' && run.result.length > 0,
    error_code: str(run?.error_code, 64),
    created_at: Number(run?.created_at) || 0,
    finished_at: Number(run?.finished_at) || 0,
    duration_s: Number(run?.duration_s) || 0,
  }
}

function trimState(state) {
  const runs = Array.isArray(state?.runs) ? state.runs.map(trimRun) : []
  const byState = {}
  for (const run of runs) byState[run.state] = (byState[run.state] || 0) + 1
  return {
    online: true,
    generated_at: Number(state?.generated_at) || 0,
    runs,
    messages: (Array.isArray(state?.messages) ? state.messages : []).slice(0, 40).map(m => ({
      message_id: str(m?.message_id, 64),
      msg_type: str(m?.msg_type, 48),
      sender_instance_id: str(m?.sender_instance_id, 64),
      target_instance_id: str(m?.target_instance_id, 64),
      delivery_state: str(m?.delivery_state, 32),
      created_at: Number(m?.created_at) || 0,
    })),
    workspaces: (Array.isArray(state?.workspaces) ? state.workspaces : []).slice(0, 40).map(w => ({
      workspace_id: str(w?.workspace_id, 64),
      path: str(w?.path, 400),
      writable: Number(w?.writable) === 1,
      created_at: Number(w?.created_at) || 0,
    })),
    agents: (Array.isArray(state?.agents) ? state.agents : []).slice(0, 40).map(a => ({
      instance_id: str(a?.instance_id, 64),
      agent_id: str(a?.agent_id, 64),
      version: str(a?.version, 32),
      workspace_id: str(a?.workspace_id, 64),
      capabilities: a?.capabilities && typeof a.capabilities === 'object' ? a.capabilities : {},
      last_seen_at: Number(a?.last_seen_at) || 0,
    })),
    adapters: state?.adapters && typeof state.adapters === 'object' ? state.adapters : {},
    stats: { total: runs.length, by_state: byState, active: runs.filter(r => r.state === 'pending' || r.state === 'running').length },
  }
}

/** Read-only console view. The token is not needed and is not requested. */
export async function readBridgeState(port) {
  return trimState(await callJson(port, '/console/state'))
}

/** Control path. The token stays in this process; only the outcome is returned. */
export async function cancelBridgeRun(bridgeDir, port, runId) {
  const token = readAdminToken(bridgeDir)
  if (!token) throw new Error('BRIDGE_TOKEN_MISSING')
  const result = await callJson(port, '/console/cancel', { method: 'POST', body: { run_id: String(runId || '').slice(0, 64) }, token })
  return { ok: result?.ok === true, error_code: str(result?.error_code, 64) }
}

function ownershipPath() {
  return join(bridgeHome(), OWNERSHIP_FILE)
}

function readOwnership() {
  try { return JSON.parse(readFileSync(ownershipPath(), 'utf8')) } catch { return null }
}

function writeOwnership(record) {
  const target = ownershipPath()
  const temporary = `${target}.${process.pid}.tmp`
  // Rename over the target keeps a half-written file from ever being read.
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
  renameSync(temporary, target)
}

function recordMatches(record, trusted) {
  return record && ['token', 'pid', 'owner', 'bridgeDir', 'port', 'startedAt']
    .every(key => record[key] === trusted[key])
}

function clearOwnership(record) {
  try {
    if (recordMatches(readOwnership(), record)) unlinkSync(ownershipPath())
  } catch { /* already gone */ }
}

function canonicalDirectory(directory) {
  if (typeof directory !== 'string' || !directory) return null
  try {
    const canonical = realpathSync(directory)
    if (!statSync(canonical).isDirectory()) return null
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  } catch { return null }
}

function liveChild(child) {
  return child?.exitCode === null && child.signalCode === null
}

function ownedEntry(config) {
  if (!config || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return null
  const directory = canonicalDirectory(config.bridgeDir)
  if (!directory) return null
  const record = readOwnership()
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1) return null
  const entry = children.get(record.pid)
  if (!entry || entry.ownershipFile !== ownershipPath() || entry.record.owner !== process.pid
    || entry.child.pid !== entry.record.pid || !liveChild(entry.child)
    || entry.record.bridgeDir !== directory || entry.record.port !== config.port
    || !recordMatches(record, entry.record)) return null
  return entry
}

/** Status and control share one identity check; missing configuration fails closed. */
export function bridgeOwnership(config) {
  const entry = ownedEntry(config)
  return { owned: Boolean(entry), pid: entry?.record.pid || 0 }
}

function retireEntry(entry) {
  if (children.get(entry.record.pid) !== entry) return
  if (entry.ownershipFile === ownershipPath()) clearOwnership(entry.record)
  // A timed-out taskkill helper remains tracked until its own exit is observed.
  if (!liveChild(entry.stopHelper)) children.delete(entry.record.pid)
}

function pythonCandidates() {
  const override = process.env.DSH_BRIDGE_PYTHON
  return override ? [override] : ['python', 'python3', 'py']
}

export async function startBridge({ bridgeDir, port }) {
  if (!bridgeDir) return { ok: false, error: 'BRIDGE_DIR_NOT_CONFIGURED' }
  const directory = canonicalDirectory(bridgeDir)
  if (!directory || !existsSync(join(directory, 'start.py'))) return { ok: false, error: 'BRIDGE_DIR_INVALID' }
  const probe = await probeBridge(port)
  // A healthy Bridge is adopted, never duplicated on the same port.
  if (probe.online) return { ok: true, adopted: true, instances: probe.instances }
  if (probe.reason === 'PORT_NOT_BRIDGE') return { ok: false, error: 'PORT_NOT_BRIDGE' }
  const token = randomUUID()
  let child
  let lastError = 'NO_PYTHON'
  for (const python of pythonCandidates()) {
    try {
      child = spawn(python, ['start.py'], {
        cwd: directory, stdio: 'ignore', windowsHide: true,
        // POSIX needs its own process group so the whole tree can be signalled.
        ...(process.platform === 'win32' ? {} : { detached: true }),
      })
      // ENOENT is emitted asynchronously, including candidates with no pid.
      child.on('error', error => { lastError = error.code || 'SPAWN_FAILED' })
    } catch (error) { lastError = error.code || error.message; continue }
    if (!child.pid) { lastError = 'SPAWN_FAILED'; continue }
    break
  }
  if (!child?.pid) return { ok: false, error: lastError }
  child.unref()
  const record = Object.freeze({ token, pid: child.pid, port, bridgeDir: directory, startedAt: Date.now(), owner: process.pid })
  const entry = { child, record, ownershipFile: ownershipPath(), stopping: null, stopHelper: null }
  children.set(child.pid, entry)
  child.once('exit', () => retireEntry(entry))
  writeOwnership(record)
  // Python cold start is seconds, not milliseconds: poll instead of assuming.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const live = await probeBridge(port)
    if (live.online) return { ok: true, adopted: false, instances: live.instances }
    if (!liveChild(child)) break
  }
  return { ok: false, error: 'BRIDGE_START_TIMEOUT' }
}

function waitForExit(child) {
  let finish
  const promise = new Promise(resolve => { finish = resolve })
  const exited = () => { clearTimeout(timer); child.off('exit', exited); finish(true) }
  const timer = setTimeout(() => { child.off('exit', exited); finish(false) }, STOP_TIMEOUT_MS)
  child.once('exit', exited)
  if (!liveChild(child)) exited()
  return { promise, cancel() { clearTimeout(timer); child.off('exit', exited); finish(false) } }
}

function windowsStop(entry) {
  if (liveChild(entry.stopHelper)) return Promise.resolve({ ok: false, timedOut: false })
  return new Promise(resolve => {
    let killer, settled = false, timedOut = false, exitTimer
    const finish = outcome => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(exitTimer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      // This helper was created here; never signal an unrelated process.
      if (killer && liveChild(killer)) try { killer.kill() } catch { /* helper already exited */ }
      // Signalling is not exit. Await the helper, but retain its handle if the
      // bounded cleanup budget expires, rather than pretending it is gone.
      if (!liveChild(killer)) return finish({ ok: false, timedOut: true })
      exitTimer = setTimeout(() => finish({ ok: false, timedOut: true }), STOP_HELPER_EXIT_MS)
    }, STOP_HELPER_TIMEOUT_MS)
    try {
      killer = spawn('taskkill', ['/pid', String(entry.record.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      entry.stopHelper = killer
      killer.once('exit', code => {
        if (entry.stopHelper === killer) entry.stopHelper = null
        if (!liveChild(entry.child)) retireEntry(entry)
        finish({ ok: !timedOut && code === 0, timedOut })
      })
      killer.once('error', () => {
        if (!killer.pid && entry.stopHelper === killer) entry.stopHelper = null
        if (!liveChild(entry.child)) retireEntry(entry)
        finish({ ok: false, timedOut })
      })
    } catch { finish({ ok: false, timedOut: false }) }
  })
}

async function stopOwned(config, entry) {
  // No await separates this last identity check from signalling the child.
  if (ownedEntry(config) !== entry) return { ok: false, error: 'NOT_OWNED' }
  const { child } = entry, waiting = waitForExit(child)
  try {
    let outcome
    if (process.platform === 'win32') {
      outcome = await windowsStop(entry)
    } else {
      try {
        process.kill(-entry.record.pid, 'SIGTERM')
        outcome = { ok: true, timedOut: false }
      } catch { outcome = { ok: false, timedOut: false } }
    }
    if (!liveChild(child)) { retireEntry(entry); return { ok: true } }
    if (!outcome.ok) return { ok: false, error: outcome.timedOut ? 'BRIDGE_STOP_TIMEOUT' : 'BRIDGE_STOP_FAILED' }
    if (!await waiting.promise) return { ok: false, error: 'BRIDGE_STOP_TIMEOUT' }
    retireEntry(entry)
    return { ok: true }
  } finally { waiting.cancel() }
}

export async function stopBridge(config) {
  const entry = ownedEntry(config)
  if (!entry) return { ok: false, error: 'NOT_OWNED' }
  // A second authenticated caller joins the same stop, rather than signalling twice.
  if (!entry.stopping) {
    entry.stopping = stopOwned(config, entry).finally(() => { entry.stopping = null })
  }
  return entry.stopping
}

/** Only used by tests and by the plugin disposer, never by a request. */
export function forgetBridgeChild(pid) {
  children.delete(pid)
}
