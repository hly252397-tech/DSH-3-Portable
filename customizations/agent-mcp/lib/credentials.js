import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Separate credentials from ephemeral discovery. Also permits upgrading the old
// plugin, whose disposer removes agent-mcp.json, without invalidating clients.
export function ensureToken(home) {
  const path = join(home, 'agent-mcp.token')
  try {
    const token = readFileSync(path, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid persistent MCP credential; restore it explicitly')
    return token
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let token
  try {
    const existing = JSON.parse(readFileSync(join(home, 'agent-mcp.json'), 'utf8')).token
    if (/^[a-f0-9]{64}$/.test(existing)) token = existing
  } catch (error) { if (error.code && error.code !== 'ENOENT') throw error }
  token ||= randomBytes(32).toString('hex')
  try { writeFileSync(path, token, { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (error.code === 'EEXIST') return ensureToken(home); throw error }
  return token
}
