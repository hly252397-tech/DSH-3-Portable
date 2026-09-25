import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSourceAdapters, collectFromSources, validateSourceUrl } from '../lib/sources.js'

function withFetch(t, implementation) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = implementation
}

test('rejects insecure, private and non-allowlisted source URLs', () => {
  assert.throws(() => validateSourceUrl('http://example.com', ['example.com']), /HTTPS/)
  assert.throws(() => validateSourceUrl('https://127.0.0.1/x', []), /内网/)
  assert.throws(() => validateSourceUrl('https://evil.test/x', ['example.com']), /允许列表/)
  assert.throws(() => validateSourceUrl('mock://other', []), /mock 源只支持/)
})

test('collects a public JSON feed without network in tests', async t => {
  withFetch(t, async () => new Response(JSON.stringify({ items: [{
    sourceId: '1', title: 'Lenovo ThinkStation P3 Tiny i5-13500T',
    url: 'https://feed.example/item/1', price: 1300, currency: 'CNY',
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const result = await collectFromSources(['https://feed.example/listings.json'], {
    allowlist: ['feed.example'], retries: 0,
  })
  assert.equal(result.errors.length, 0)
  assert.equal(result.listings.length, 1)
  assert.equal(result.listings[0].source, 'feed.example')
})

test('HTTP 403 degrades to SOURCE_BLOCKED with anti_bot reason, not UPSTREAM_ERROR', async t => {
  withFetch(t, async () => new Response('blocked', { status: 403 }))
  const result = await collectFromSources(['https://blocked.example/search'], {
    allowlist: ['blocked.example'], retries: 1,
  })
  assert.equal(result.listings.length, 0)
  assert.equal(result.errors.length, 1)
  assert.deepEqual(
    { code: result.errors[0].code, status: result.errors[0].status, reason: result.errors[0].reason, source: result.errors[0].source },
    { code: 'SOURCE_BLOCKED', status: 'blocked', reason: 'anti_bot', source: 'blocked.example' },
  )
})

test('HTTP 401 degrades to SOURCE_BLOCKED with auth_required reason', async t => {
  withFetch(t, async () => new Response('denied', { status: 401 }))
  const result = await collectFromSources(['https://auth.example/search'], {
    allowlist: ['auth.example'], retries: 0,
  })
  assert.equal(result.errors[0].code, 'SOURCE_BLOCKED')
  assert.equal(result.errors[0].reason, 'auth_required')
})

test('HTTP 500 stays a retryable UPSTREAM_ERROR without blocked semantics', async t => {
  withFetch(t, async () => new Response('oops', { status: 500 }))
  const result = await collectFromSources(['https://flaky.example/search'], {
    allowlist: ['flaky.example'], retries: 0,
  })
  assert.equal(result.errors[0].code, 'UPSTREAM_ERROR')
  assert.equal(result.errors[0].status, undefined)
  assert.equal(result.errors[0].reason, undefined)
})

test('mock source is refused unless explicitly enabled', async () => {
  const disabled = await collectFromSources(['mock://fixed'], { allowlist: [] })
  assert.equal(disabled.listings.length, 0)
  assert.equal(disabled.errors[0].code, 'CONFIG_ERROR')
  assert.equal(buildSourceAdapters({ mockEnabled: false }).some(adapter => adapter.id === 'mock'), false)
  assert.equal(buildSourceAdapters({ mockEnabled: true }).some(adapter => adapter.id === 'mock'), true)
})

test('enabled mock source yields the three fixed development listings', async () => {
  const result = await collectFromSources(['mock://fixed'], { allowlist: [], mockEnabled: true })
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.listings.map(listing => listing.price).sort((a, b) => a - b), [1200, 1800, 2200])
  assert.ok(result.listings.every(listing => listing.source === 'mock'))
  assert.ok(result.listings.every(listing => listing.currency === 'CNY'))
})
