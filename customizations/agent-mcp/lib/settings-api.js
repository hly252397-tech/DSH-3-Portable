import { bridgeOwnership, cancelBridgeRun, probeBridge, readBridgeState, startBridge, stopBridge } from './bridge-link.js'

// A Bridge cold start is a Python process launch: it needs seconds, while every
// other operation must stay inside the browser's patience budget.
const DEADLINES = { 'bridge.start': 45000, 'bridge.stop': 15000 }
const DEFAULT_DEADLINE_MS = 10000

// The UI uses the DSH authenticated origin, never relaxes /mcp's browser fence.
export function trustedSettingsRequest(req) {
  const authority = req.headers.host
  if (typeof authority !== 'string') return false
  let url
  try { url = new URL('http://' + authority) } catch { return false }
  if (url.host !== authority.toLowerCase() || url.username || url.password) return false
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false
  if (req.socket.localPort && Number(url.port || 80) !== req.socket.localPort) return false
  if (req.headers.origin !== undefined && req.headers.origin !== url.origin) return false
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false
  return req.headers['x-dsh-agent-mcp'] === '1'
}

export async function checkMcp({ url, token }, signal) {
  const target = new URL(url)
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || target.pathname !== '/mcp') throw new Error('Invalid endpoint')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  let sessionId
  const rpc = async (method, params, id) => {
    const response = await fetch(url, { method: 'POST', headers, redirect: 'error', signal,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) })
    if (method === 'initialize') sessionId = response.headers.get('mcp-session-id')
    if (!response.ok) throw new Error('MCP HTTP failure')
    const data = await response.json()
    if (data.jsonrpc !== '2.0' || data.id !== id || data.error) throw new Error('MCP protocol failure')
    return data.result
  }
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-settings-check', version: '1' } }, 1)
    if (!sessionId || initialized?.serverInfo?.name !== 'dsh-agent-mcp') throw new Error('Unexpected MCP server')
    headers['mcp-session-id'] = sessionId
    headers['mcp-protocol-version'] = initialized.protocolVersion
    const notified = await fetch(url, { method: 'POST', headers, redirect: 'error', signal,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    if (notified.status !== 202) throw new Error('MCP notification failure')
    const listed = await rpc('tools/list', {}, 2)
    if (!Array.isArray(listed?.tools)) throw new Error('Missing tool catalog')
    const expected = ['dsh_capabilities', 'dsh_list_sessions', 'dsh_send_task', 'dsh_task_status', 'dsh_cancel_task', 'dsh_read_state']
    const tools = listed.tools.map(tool => tool.name)
    if (tools.length !== expected.length || expected.some(name => !tools.includes(name))) throw new Error('Unexpected tool catalog')
    return { protocolVersion: initialized.protocolVersion, tools, checkedAt: Date.now() }
  } finally {
    // Independent bounded cleanup, including timeout/cancel paths.
    if (sessionId) await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sessionId },
      redirect: 'error', signal: AbortSignal.timeout(1000) }).catch(() => {})
  }
}

export function registerMcpSettings(ctx, access, bridge = null) {
  ctx.inject(['webServer', 'connection'], inner => inner.effect(() => {
    const lifetime = new AbortController(), requests = new Set(), tasks = new Set()
    let checking = false
    const unregister = inner.webServer.register({ kind: 'exact', path: '/dsh-agent-mcp/settings', handler: (req, res) => {
      const task = (async () => {
        requests.add(req)
        // The deadline is re-armed once the operation is known, so a slow
        // Bridge start cannot be cut off by the default budget.
        let timer = setTimeout(() => req.destroy(), DEFAULT_DEADLINE_MS)
        const rearm = ms => { clearTimeout(timer); timer = setTimeout(() => req.destroy(), ms) }
        const send = (status, body) => {
          if (res.destroyed || res.writableEnded) return
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(JSON.stringify(body))
        }
        try {
          if (lifetime.signal.aborted) return send(503, { error: 'UNAVAILABLE' })
          if (!trustedSettingsRequest(req)) return send(403, { error: 'FORBIDDEN' })
          if (typeof inner.connection.requestRejection !== 'function') return send(503, { error: 'AUTH_UNAVAILABLE' })
          const rejected = inner.connection.requestRejection(req)
          if (rejected) return send(rejected === 401 ? 401 : 403, { error: 'UNAUTHORIZED' })
          if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' })
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(415, { error: 'CONTENT_TYPE' })
          let size = 0; const chunks = []
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            size += chunk.length
            if (size > 1024) { req.resume(); return send(413, { error: 'BODY_TOO_LARGE' }) }
            chunks.push(chunk)
          }
          let args
          try { args = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'INVALID_JSON' }) }
          const allowed = ['status', 'credentials', 'check', 'bridge.status', 'bridge.start', 'bridge.stop', 'bridge.cancel']
          if (!args || Array.isArray(args)) return send(400, { error: 'INVALID_OPERATION' })
          const keys = Object.keys(args)
          const shapeOk = allowed.includes(args.operation)
            && (keys.length === 1 || (args.operation === 'bridge.cancel' && keys.length === 2 && keys.includes('run_id')))
          if (!shapeOk) return send(400, { error: 'INVALID_OPERATION' })
          rearm(DEADLINES[args.operation] || DEFAULT_DEADLINE_MS)
          if (lifetime.signal.aborted) return send(503, { error: 'UNAVAILABLE' })
          if (args.operation.startsWith('bridge.')) {
            if (!bridge) return send(503, { error: 'BRIDGE_NOT_CONFIGURED' })
            // An unconfigured Bridge is a state the page renders, not an error.
            if (!bridge.dir) return send(200, { value: { online: false, reason: 'BRIDGE_DIR_NOT_CONFIGURED', owned: false, dir: '', port: bridge.port } })
            try {
              if (args.operation === 'bridge.status') {
                const probe = await probeBridge(bridge.port)
                // Only a verified Bridge contributes state; an unknown port is
                // reported as such rather than probed further. `owned` rides along
                // so the page can offer Stop only when Stop can actually work.
                if (!probe.online) return send(200, { value: { online: false, reason: probe.reason, owned: false, dir: bridge.dir, port: bridge.port } })
                const state = await readBridgeState(bridge.port)
                return send(200, { value: { ...state, owned: bridgeOwnership({ bridgeDir: bridge.dir, port: bridge.port }).owned, dir: bridge.dir, port: bridge.port } })
              }
              if (args.operation === 'bridge.start') return send(200, { value: await startBridge({ bridgeDir: bridge.dir, port: bridge.port }) })
              if (args.operation === 'bridge.stop') return send(200, { value: await stopBridge({ bridgeDir: bridge.dir, port: bridge.port }) })
              const runId = args.run_id
              if (typeof runId !== 'string' || !runId) return send(400, { error: 'INVALID_RUN_ID' })
              return send(200, { value: await cancelBridgeRun(bridge.dir, bridge.port, runId) })
            } catch (error) {
              // Never echo the message: it can quote a Bridge URL or token path.
              return send(502, { error: 'BRIDGE_UNAVAILABLE', reason: String(error?.message || '').slice(0, 120) })
            }
          }
          const status = access.status()
          if (args.operation === 'status') return send(200, { value: { ...status, bridgeConfigured: Boolean(bridge?.dir), httpChannel: typeof access.httpChannel === 'function' ? access.httpChannel() : null } })
          if (!status.running) return send(503, { error: 'UNAVAILABLE' })
          if (args.operation === 'credentials') return send(200, { value: access.credentials() })
          if (checking) return send(409, { error: 'CHECK_BUSY' })
          checking = true
          try {
            const result = await checkMcp(access.credentials(), AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]))
            send(200, { value: result })
          } finally { checking = false }
        } catch { send(503, { error: 'CHECK_FAILED' }) }
        finally { clearTimeout(timer); requests.delete(req) }
      })()
      tasks.add(task)
      void task.finally(() => tasks.delete(task))
      return task
    } })
    return async () => { lifetime.abort(); unregister(); for (const req of requests) req.destroy(); await Promise.allSettled([...tasks]) }
  }, 'agent-mcp: authenticated settings API'))
}
