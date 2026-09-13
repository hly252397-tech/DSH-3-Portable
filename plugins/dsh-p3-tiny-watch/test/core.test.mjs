import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dedupeListings,
  evaluateAlerts,
  extractListingsFromHtml,
  isTrustedCandidate,
  normalizeListing,
} from '../lib/core.js'

const rates = { CNY: 1, USD: 7.2, GBP: 9.3 }

function item(overrides = {}) {
  return normalizeListing({
    source: 'example',
    sourceId: '1',
    title: 'Lenovo ThinkStation P3 Tiny i5-13500T 16GB barebone',
    url: 'https://example.com/itm/123456789',
    price: 190,
    shipping: 10,
    currency: 'USD',
    capturedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  }, { rates, now: Date.parse('2026-09-13T00:00:00Z') })
}

test('normalizes a valid P3 Tiny and calculates landed CNY price', () => {
  const listing = item()
  assert.equal(listing.totalCny, 1440)
  assert.equal(listing.unitCny, 1440)
  assert.equal(listing.cpu, 'i5-13500T')
  assert.equal(isTrustedCandidate(listing), true)
})

test('rejects accessory-only listings from trusted candidates', () => {
  const listing = item({ title: 'Lenovo P3 Tiny power adapter only', sourceId: '2', price: 20 })
  assert.ok(listing.flags.includes('ACCESSORY_ONLY'))
  assert.equal(isTrustedCandidate(listing), false)
})

test('flags impossible old CPU generation as model mismatch', () => {
  const listing = item({ title: 'Lenovo ThinkStation P3 Tiny i7-7700T', sourceId: '3' })
  assert.ok(listing.flags.includes('MODEL_MISMATCH'))
  assert.equal(isTrustedCandidate(listing), false)
})

test('does not threshold-match when FX rate is unavailable', () => {
  const listing = normalizeListing({
    source: 'jp', sourceId: '4', title: 'ThinkStation P3 Tiny i5-13500T',
    url: 'https://example.com/4', price: 50000, currency: 'JPY',
  }, { rates: { CNY: 1 } })
  assert.ok(listing.flags.includes('FX_RATE_MISSING'))
  assert.equal(listing.unitCny, undefined)
  assert.equal(isTrustedCandidate(listing), false)
})

test('calculates unit price for batch listings', () => {
  const listing = normalizeListing({
    source: 'batch', sourceId: '5', title: 'Lot of 5 Lenovo ThinkStation P3 Tiny i5-13500T',
    url: 'https://example.com/5', price: 5000, currency: 'CNY',
  }, { rates })
  assert.equal(listing.quantity, 5)
  assert.equal(listing.unitCny, 1000)
  assert.ok(listing.flags.includes('BATCH_LISTING'))
})

test('deduplicates same source item and keeps better candidate', () => {
  const lowConfidence = item({ title: 'ThinkStation P3 Tiny CPU unknown', sourceId: '6' })
  const highConfidence = item({ sourceId: '6' })
  const output = dedupeListings([lowConfidence, highConfidence])
  assert.equal(output.length, 1)
  assert.equal(output[0].cpu, 'i5-13500T')
})

test('alerts once and alerts again only after a lower price', () => {
  const listing = item({ sourceId: '7' })
  const first = evaluateAlerts([listing], {}, { thresholdCny: 1500, now: 1 })
  assert.equal(first.alerts.length, 1)
  const state = {
    listings: { [listing.key]: listing },
    alerts: { [listing.key]: { unitCny: listing.unitCny } },
  }
  const same = evaluateAlerts([listing], state, { thresholdCny: 1500, now: 2 })
  assert.equal(same.alerts.length, 0)
  const lower = item({ sourceId: '7', price: 150 })
  const dropped = evaluateAlerts([lower], state, { thresholdCny: 1500, now: 3 })
  assert.equal(dropped.alerts.length, 1)
})

test('extracts JSON-LD products', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Lenovo ThinkStation P3 Tiny i5-13500T', sku: 'abc',
    url: '/item/abc', offers: { price: '199', priceCurrency: 'USD' },
  })}</script>`
  const result = extractListingsFromHtml(html, 'https://example.com/search')
  assert.equal(result.length, 1)
  assert.equal(result[0].sourceId, 'abc')
  assert.equal(result[0].url, 'https://example.com/item/abc')
})

test('extracts a minimal eBay result card', () => {
  const html = `<li class="s-item"><a class="s-item__link" href="https://www.ebay.com/itm/123456789"><div class="s-item__title">Lenovo ThinkStation P3 Tiny i5-13500T</div><span class="s-item__price">US $199.00</span><span class="s-item__shipping">US $20.00 shipping</span></a></li>`
  const result = extractListingsFromHtml(html, 'https://www.ebay.com/sch/i.html')
  assert.equal(result.length, 1)
  assert.equal(result[0].sourceId, '123456789')
})
