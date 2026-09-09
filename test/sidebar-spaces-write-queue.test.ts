import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

async function harness() {
  const source = await readFile(resolve('Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js'), 'utf8')
  const start = source.indexOf('function usePortableState(key)')
  const end = source.indexOf('function StorageStatus(', start)
  const cache = new Map([['database', { revision: 0, data: { cell: '', fields: [] as string[] } }]])
  const states: unknown[] = []
  const requests: Array<{ payload: any, resolve: (value: any) => void, reject: (error: Error) => void }> = []
  const usePortableState = runInNewContext(`(${source.slice(start, end).trim()})`, {
    useState(initial: any) { const index = states.length; states.push(typeof initial === 'function' ? initial() : initial); return [states[index], (next: unknown) => { states[index] = next }] },
    useRef: (current: unknown) => ({ current }), useEffect: (effect: () => void) => effect(),
    readJson: () => cache.get('database')!.data, portableCache: cache,
    storeCall: (_action: string, _key: string, payload: unknown) => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })),
    AbortSignal, window: { dispatchEvent() {} }, CustomEvent: class {}, STORE_EVENT: 'commit',
  })
  const [, save] = usePortableState('database')
  return { save, states, requests }
}

test('a blur save followed by add-field keeps both writes and advances the committed revision', async () => {
  const h = await harness()
  const first = h.save((data: any) => ({ ...data, cell: 'edited' }))
  const second = h.save((data: any) => ({ ...data, fields: [...data.fields, 'note'] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.requests.length, 1)
  assert.equal(h.states[1], 'saving')
  h.requests[0]!.resolve({ revision: 1, data: h.requests[0]!.payload.data })
  assert.equal(await first, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1]!.payload.revision, 1)
  assert.equal(h.requests[1]!.payload.data.cell, 'edited')
  assert.equal(h.requests[1]!.payload.data.fields[0], 'note')
  h.requests[1]!.resolve({ revision: 2, data: h.requests[1]!.payload.data })
  assert.equal(await second, true)
  assert.equal(h.states[1], 'ready')
})

test('revision conflicts stop queued writes and retain the last committed view', async () => {
  const h = await harness()
  const first = h.save((data: any) => ({ ...data, cell: 'uncommitted' }))
  const second = h.save((data: any) => ({ ...data, fields: ['note'] }))
  await new Promise(resolve => setImmediate(resolve))
  h.requests[0]!.reject(new Error('revision-conflict'))
  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.equal(h.requests.length, 1)
  assert.equal(h.states[1], 'conflict')
  assert.equal((h.states[0] as any).cell, '')
})
