import test from 'node:test'
import assert from 'node:assert/strict'

import { collectFromSources } from '../lib/sources.js'
import { extractKleinanzeigenCards } from '../lib/sources-kleinanzeigen.js'
import { normalizeListing, isTrustedCandidate } from '../lib/core.js'

// fixture 按真实搜索页卡片结构复刻（2026-09 实测抓取后裁剪），不是行情数据本身。
function card(id, title, description, href, priceHtml) {
  return `<li data-clickable="card"><article class="flex justify-between p-medium" data-adid="${id}" data-href="${href}">`
    + `<script type="application/ld+json">${JSON.stringify({ creditText: 'Kleinanzeigen', title, description, '@type': 'ImageObject' })}</script>`
    + `<a href="${href}"><div data-image-container></div></a>`
    + `<p class="my-xsmall text-title3 font-strong text-secondary">${priceHtml}</p>`
    + `<p class="text-bodySmall">Versand möglich</p>`
    + '</article></li>'
}

const FIXTURE_HTML = [
  '<!doctype html><html><body><ul id="srchrslt-adtable">',
  card('3514536528', 'Lenovo ThinkStation P3 Tiny', 'Gebrauchtes Lenovo ThinkStation P3 Tiny, sehr guter Zustand.', '/s-anzeige/lenovo-thinkstation-p3-tiny/3514536528-228-9417', '999 €'),
  card('3510979823', 'Lenovo ThinkStation P3 Tiny Gen 2, Core Ultra 7, 32GB', 'Aktueller Neupreis liegt bei rund 1700 Euro.', '/s-anzeige/lenovo-thinkstation-p3-tiny-gen-2/3510979823-228-6936', '1.300 €'),
  card('3420439531', 'Lenovo P3 Tiny Workstation i7-14700T', 'Komplettsystem mit T400.', '/s-anzeige/lenovo-p3-tiny-workstation/3420439531-228-9232', '1.950,50 €'),
  card('3500000000', 'Lenovo P3 Tiny geschenk', 'Zu verschenken an Schüler.', '/s-anzeige/lenovo-p3-tiny-geschenk/3500000000-228-1111', 'Zu verschenken'),
  '<li><article data-adid="3500000001" data-href="/s-anzeige/no-price/3500000001-1-1"><p>ohne Preis</p></article></li>',
  '</ul></body></html>',
].join('')

test('parses real kleinanzeigen card structure with German price format', () => {
  const listings = extractKleinanzeigenCards(FIXTURE_HTML, 'https://www.kleinanzeigen.de/s-lenovo-p3-tiny/k0')
  assert.equal(listings.length, 4)
  assert.deepEqual(listings.map(listing => listing.price), [999, 1300, 1950.5, 0])
  assert.equal(listings[0].sourceId, '3514536528')
  assert.equal(listings[0].url, 'https://www.kleinanzeigen.de/s-anzeige/lenovo-thinkstation-p3-tiny/3514536528-228-9417')
  assert.equal(listings[0].currency, 'EUR')
  assert.equal(listings[0].title, 'Lenovo ThinkStation P3 Tiny')
  assert.ok(listings[0].description.includes('sehr guter Zustand'))
})

test('normalized kleinanzeigen listings become trusted candidates with EUR rate', () => {
  const rates = { CNY: 1, EUR: 7.8 }
  const listings = extractKleinanzeigenCards(FIXTURE_HTML, 'https://www.kleinanzeigen.de/s-lenovo-p3-tiny/k0')
  const normalized = listings.map(listing => normalizeListing(listing, { rates, now: Date.parse('2026-09-19T00:00:00Z') }))
  const cheap = normalized[0]
  assert.equal(cheap.totalCny, Math.round(999 * 7.8 * 100) / 100)
  assert.equal(isTrustedCandidate(cheap), true)
  const gifted = normalized[3]
  assert.equal(gifted.unitCny, 0)
  assert.equal(isTrustedCandidate(gifted), true)
})

test('collectFromSources routes kleinanzeigen URLs through the dedicated adapter', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(FIXTURE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const result = await collectFromSources(['https://www.kleinanzeigen.de/s-lenovo-p3-tiny/k0'], {
    allowlist: ['kleinanzeigen.de'], retries: 0,
  })
  assert.equal(result.errors.length, 0)
  assert.equal(result.listings.length, 4)
  assert.ok(result.listings.every(listing => listing.source === 'kleinanzeigen.de'))
})
