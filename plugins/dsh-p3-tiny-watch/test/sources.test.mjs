import test from 'node:test'
import assert from 'node:assert/strict'

import { collectFromSources, validateSourceUrl } from '../lib/sources.js'

test('rejects insecure, private and non-allowlisted source URLs', () => {
  assert.throws(() => validateSourceUrl('http://example.com', ['example.com']), /HTTPS/)
  assert.throws(() => validateSourceUrl('https://127.0.0.1/x', []), /内网/)
  assert.throws(() => validateSourceUrl('https://evil.test/x', ['example.com']), /允许列表/)
})

test('collects a public JSON feed without network in tests', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [{
    sourceId: '1', title: 'Lenovo ThinkStation P3 Tiny i5-13500T',
    url: 'https://feed.example/item/1', price: 1300, currency: 'CNY',
  }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const result = await collectFromSources(['https://feed.example/listings.json'], {
    allowlist: ['feed.example'], retries: 0,
  })
  assert.equal(result.errors.length, 0)
  assert.equal(result.listings.length, 1)
  assert.equal(result.listings[0].source, 'feed.example')
})
