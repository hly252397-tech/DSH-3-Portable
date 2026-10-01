import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const load = () => import(pathToFileURL(resolve('plugins/dsh-manual/lib/api.js')).href)

test('manual dispatch limits operations, authors and write authority', async () => {
  const { dispatchManual } = await load()
  const calls: any[] = []
  const store = { edit: async (args: any) => { calls.push(args); return { id: args.id } }, sync: async () => ({ synced: 1 }) }
  await assert.rejects(dispatchManual(store, { operation: 'constructor' }), { code: 'INVALID_OPERATION' })
  await assert.rejects(dispatchManual(store, { operation: 'edit', id: 'notes/x' }), { code: 'REVISION_REQUIRED' })
  await assert.rejects(dispatchManual(store, { operation: 'edit', expectedRevision: null }, { writable: false }), { code: 'READ_ONLY' })
  await dispatchManual(store, { operation: 'edit', id: 'notes/x', expectedRevision: null, content: '# Draft', author: 'admin', status: 'verified', root: 'C:/' })
  assert.equal(calls[0].author, 'model')
  assert.equal(calls[0].status, undefined)
  assert.equal(calls[0].root, undefined)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(dispatchManual(store, { operation: 'sync' }, { signal: abort.signal }), { name: 'AbortError' })
  assert.equal(calls.length, 1)
})

test('manual web trust requires exact origin, known host and custom header', async () => {
  const { trustedManualRequest } = await load()
  const request = (headers: Record<string, string>) => ({ headers: { host: '127.0.0.1:8975', 'x-dsh-manual': '1', ...headers } })
  assert.equal(trustedManualRequest(request({})), true)
  assert.equal(trustedManualRequest(request({ origin: 'http://127.0.0.1:8975' })), true)
  const deniedHeaders: Record<string, string>[] = [
    { origin: 'http://127.0.0.1:8976' }, { origin: 'https://evil.invalid' },
    { host: '127.evil.invalid' }, { host: 'evil.invalid' }, { 'x-dsh-manual': '' },
    { 'sec-fetch-site': 'cross-site' }, { host: 'user@127.0.0.1:8975' },
  ]
  for (const headers of deniedHeaders) assert.equal(trustedManualRequest(request(headers)), false, JSON.stringify(headers))
  assert.equal(trustedManualRequest(request({ host: 'harness.internal:80' }), ['harness.internal']), false, 'noncanonical default-port authority is rejected')
  assert.equal(trustedManualRequest(request({ host: 'harness.internal:8975' }), ['harness.internal:8975']), true)
})

test('manual HTTP body is bounded and internal filesystem errors stay private', async () => {
  const { readBody, safeError, MAX_BODY_BYTES } = await load()
  assert.deepEqual(await readBody(Readable.from([Buffer.from('{"operation":"list"}')])), { operation: 'list' })
  await assert.rejects(readBody(Readable.from([Buffer.from('{')])), { code: 'INVALID_JSON' })
  await assert.rejects(readBody(Readable.from([Buffer.alloc(MAX_BODY_BYTES + 1)])), { code: 'PAYLOAD_TOO_LARGE' })
  assert.deepEqual(safeError(new Error('secret C:/private/key')), { code: 'STORAGE_UNAVAILABLE' })
  assert.deepEqual(safeError({ code: 'REVISION_CONFLICT', currentRevision: 'abcd', message: 'private' }), { code: 'REVISION_CONFLICT', currentRevision: 'abcd' })
})
