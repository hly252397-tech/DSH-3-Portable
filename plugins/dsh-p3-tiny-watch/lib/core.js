const ACCESSORY_TERMS = [
  'adapter only', 'power adapter', 'ac adapter', 'bracket', 'mount', 'stand', 'vesa',
  'motherboard only', 'mainboard only', 'board only', 'case only', 'chassis only',
  'gpu only', 'graphics card only', 'heatsink', 'fan only', 'cable only', 'parts only',
  '仅电源', '电源适配器', '仅适配器', '支架', '挂架', '底座', '主板', '空壳', '机箱',
  '仅显卡', '散热器', '风扇', '线材', '配件', '零件',
]

const DAMAGE_TERMS = [
  'for parts', 'not working', 'does not power', "doesn't power", 'no power', 'broken',
  'damaged', 'untested', 'as-is', 'repair', 'spares', 'bios lock', 'password locked',
  '损坏', '不开机', '不能开机', '无电', '故障', '维修', '待修', '仅供拆件', '账号锁', 'bios锁',
]

const MISSING_TERMS = [
  ['NO_SSD', ['no ssd', 'without ssd', 'ssd removed', '无硬盘', '不含硬盘', '无盘']],
  ['NO_RAM', ['no ram', 'without ram', 'memory removed', '无内存', '不含内存']],
  ['NO_ADAPTER', ['no adapter', 'without adapter', 'no psu', '无电源', '不含电源']],
]

const RENTAL_TERMS = ['rental', 'lease', 'monthly', 'deposit', '租赁', '出租', '押金', '月租']
const PREORDER_TERMS = ['preorder', 'pre-order', 'coming soon', '预售', '订金']
const P3_TINY_TERMS = ['p3 tiny', 'thinkstation p3 tiny', '联想p3 tiny', '联想 p3 tiny']

export function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizeText(value) {
  return collapseWhitespace(value).toLocaleLowerCase()
}

export function stripHtml(value) {
  return collapseWhitespace(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>'))
}

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = String(value ?? '').replace(/\s/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '')
  const match = /-?\d+(?:[.,]\d+)?/.exec(text)
  if (!match) return undefined
  const normalized = match[0].replace(',', '.')
  const result = Number(normalized)
  return Number.isFinite(result) ? result : undefined
}

export function detectCurrency(value, fallback = undefined) {
  const text = String(value ?? '').toUpperCase()
  if (/\bCNY\b|\bRMB\b|CN¥|￥/.test(text)) return 'CNY'
  if (/\bGBP\b|£/.test(text)) return 'GBP'
  if (/\bEUR\b|€/.test(text)) return 'EUR'
  if (/\bJPY\b|JP¥|円/.test(text)) return 'JPY'
  if (/\bHKD\b|HK\$/.test(text)) return 'HKD'
  if (/\bCAD\b|CA\$/.test(text)) return 'CAD'
  if (/\bAUD\b|AU\$/.test(text)) return 'AUD'
  if (/\bUSD\b|US\$|\$/.test(text)) return 'USD'
  return fallback
}

export function parseMoney(value, fallbackCurrency = undefined) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const amount = parseNumber(value.value ?? value.amount ?? value.price)
    const currency = detectCurrency(value.currency ?? value.priceCurrency ?? '', fallbackCurrency)
    return amount === undefined ? undefined : { amount, currency }
  }
  const amount = parseNumber(value)
  return amount === undefined ? undefined : { amount, currency: detectCurrency(value, fallbackCurrency) }
}

export function convertToCny(amount, currency, rates = {}) {
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const code = String(currency ?? '').toUpperCase()
  if (code === 'CNY' || code === 'RMB') return amount
  const rate = Number(rates[code])
  return Number.isFinite(rate) && rate > 0 ? amount * rate : undefined
}

export function extractBatchQuantity(title, explicitQuantity) {
  const explicit = Number(explicitQuantity)
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 10_000) return explicit
  const text = normalizeText(title)
  const patterns = [
    /\blot\s+of\s+(\d{1,4})\b/,
    /\b(\d{1,4})\s*(?:pcs?|units?|machines?|computers?|desktops?)\b/,
    /(?:批量|一批|整批)\s*(\d{1,4})\s*台/,
    /\b(\d{1,4})\s*台\b/,
  ]
  for (const pattern of patterns) {
    const value = Number(pattern.exec(text)?.[1])
    if (Number.isInteger(value) && value > 1 && value <= 10_000) return value
  }
  return 1
}

export function detectCpu(title) {
  const text = collapseWhitespace(title)
  const intel = /\b(i[3579]-?\d{4,5}[a-z]{0,2})\b/i.exec(text)?.[1]
  if (intel) return intel.toUpperCase().replace(/^I/, 'i')
  const fullIntel = /\b(?:intel\s+)?core\s+(ultra\s+\d\s+\d{3}[a-z]{0,2}|i[3579]\s*[- ]?\s*\d{4,5}[a-z]{0,2})\b/i.exec(text)?.[1]
  return fullIntel ? collapseWhitespace(fullIntel).replace(/\s*[- ]?\s*(\d)/, '-$1') : undefined
}

export function cpuGeneration(cpu) {
  const digits = /i[3579]-?(\d{4,5})/i.exec(cpu ?? '')?.[1]
  if (!digits) return undefined
  const number = Number(digits)
  if (digits.length === 5) return Number(digits.slice(0, 2))
  if (number >= 1000) return Number(digits[0])
  return undefined
}

function containsAny(text, terms) {
  return terms.some(term => text.includes(term))
}

export function classifyListing(title, description = '') {
  const text = normalizeText(`${title} ${description}`)
  const flags = []
  const isP3Tiny = P3_TINY_TERMS.some(term => text.includes(term))
  if (!isP3Tiny) flags.push('MODEL_NOT_CONFIRMED')
  if (containsAny(text, ACCESSORY_TERMS)) flags.push('ACCESSORY_ONLY')
  if (containsAny(text, DAMAGE_TERMS)) flags.push('DAMAGED_OR_UNTESTED')
  if (containsAny(text, RENTAL_TERMS)) flags.push('RENTAL')
  if (containsAny(text, PREORDER_TERMS)) flags.push('PREORDER')
  for (const [flag, terms] of MISSING_TERMS) {
    if (containsAny(text, terms)) flags.push(flag)
  }
  const cpu = detectCpu(text)
  const generation = cpuGeneration(cpu)
  if (generation !== undefined && generation < 13) flags.push('MODEL_MISMATCH')
  if (!cpu) flags.push('CPU_UNKNOWN')
  return { flags: [...new Set(flags)], cpu, isP3Tiny }
}

export function canonicalListingKey(listing) {
  const source = normalizeText(listing.source || 'unknown')
  const sourceId = collapseWhitespace(listing.sourceId)
  if (sourceId) return `${source}:${sourceId}`
  try {
    const url = new URL(listing.url)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|campid|mkcid|mkevt|toolid|customid)/i.test(key)) url.searchParams.delete(key)
    }
    return `${source}:${url.toString()}`
  } catch {
    return `${source}:${normalizeText(listing.title)}:${Number(listing.price ?? 0)}`
  }
}

export function normalizeListing(input, options = {}) {
  const title = collapseWhitespace(input.title)
  if (!title) return undefined
  const description = collapseWhitespace(input.description)
  const classification = classifyListing(title, description)
  const price = parseMoney(input.price, input.currency)
  if (!price || price.amount < 0) return undefined
  const shipping = parseMoney(input.shipping ?? 0, price.currency)
  const currency = String(price.currency ?? input.currency ?? '').toUpperCase() || undefined
  const quantity = extractBatchQuantity(title, input.quantity)
  const totalOriginal = price.amount + (shipping?.amount ?? 0)
  const totalCny = convertToCny(totalOriginal, currency, options.rates)
  const unitCny = totalCny === undefined ? undefined : totalCny / quantity
  const capturedAt = validIso(input.capturedAt) ?? new Date(options.now ?? Date.now()).toISOString()
  const flags = [...classification.flags]
  if (!currency) flags.push('CURRENCY_UNKNOWN')
  if (currency && totalCny === undefined) flags.push('FX_RATE_MISSING')
  if (quantity > 1) flags.push('BATCH_LISTING')
  if (!input.url || !isSafeHttpUrl(input.url)) flags.push('URL_INVALID')
  const confidence = computeConfidence({ title, flags, cpu: classification.cpu, url: input.url, totalCny })
  const normalized = {
    source: collapseWhitespace(input.source || hostFromUrl(input.url) || 'unknown'),
    sourceId: collapseWhitespace(input.sourceId || idFromUrl(input.url) || ''),
    title,
    description,
    url: collapseWhitespace(input.url),
    price: price.amount,
    shipping: shipping?.amount ?? 0,
    currency,
    totalOriginal,
    totalCny: roundMoney(totalCny),
    unitCny: roundMoney(unitCny),
    condition: collapseWhitespace(input.condition || 'used'),
    cpu: input.cpu || classification.cpu,
    ramGb: positiveInteger(input.ramGb),
    storageGb: nonNegativeInteger(input.storageGb),
    seller: collapseWhitespace(input.seller),
    location: collapseWhitespace(input.location),
    quantity,
    isBatch: quantity > 1 || Boolean(input.isBatch),
    capturedAt,
    confidence,
    flags: [...new Set(flags)],
  }
  normalized.key = canonicalListingKey(normalized)
  return normalized
}

export function computeConfidence({ flags = [], cpu, url, totalCny }) {
  let score = 1
  const penalties = {
    MODEL_NOT_CONFIRMED: 0.45,
    ACCESSORY_ONLY: 0.75,
    DAMAGED_OR_UNTESTED: 0.35,
    RENTAL: 0.7,
    PREORDER: 0.5,
    MODEL_MISMATCH: 0.55,
    CPU_UNKNOWN: 0.12,
    CURRENCY_UNKNOWN: 0.25,
    FX_RATE_MISSING: 0.3,
    URL_INVALID: 0.25,
  }
  for (const flag of flags) score -= penalties[flag] ?? 0.03
  if (!cpu) score -= 0.05
  if (!url) score -= 0.1
  if (totalCny === undefined) score -= 0.1
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100))
}

export function isTrustedCandidate(listing, options = {}) {
  const hardReject = new Set([
    'MODEL_NOT_CONFIRMED', 'ACCESSORY_ONLY', 'RENTAL', 'PREORDER', 'MODEL_MISMATCH',
    'CURRENCY_UNKNOWN', 'FX_RATE_MISSING', 'URL_INVALID',
  ])
  if (listing.flags.some(flag => hardReject.has(flag))) return false
  if (options.includeDamaged !== true && listing.flags.includes('DAMAGED_OR_UNTESTED')) return false
  const minimumConfidence = Number(options.minimumConfidence ?? 0.65)
  return listing.confidence >= minimumConfidence && Number.isFinite(listing.unitCny)
}

export function dedupeListings(listings) {
  const byKey = new Map()
  for (const listing of listings) {
    if (!listing?.key) continue
    const previous = byKey.get(listing.key)
    if (!previous || listing.confidence > previous.confidence || (listing.unitCny ?? Infinity) < (previous.unitCny ?? Infinity)) {
      byKey.set(listing.key, listing)
    }
  }
  return [...byKey.values()]
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function evaluateAlerts(listings, state = {}, options = {}) {
  const thresholdCny = Number(options.thresholdCny ?? 1500)
  const minimumConfidence = Number(options.minimumConfidence ?? 0.65)
  const priorListings = state.listings ?? {}
  const alerted = state.alerts ?? {}
  const trusted = listings.filter(listing => isTrustedCandidate(listing, { minimumConfidence, includeDamaged: options.includeDamaged }))
  const referenceMedian = median(trusted.map(item => item.unitCny))
  const alerts = []
  for (const listing of trusted) {
    const previous = priorListings[listing.key]
    const priorAlert = alerted[listing.key]
    const priceHit = listing.unitCny <= thresholdCny
    const batchHit = listing.isBatch && referenceMedian !== undefined && listing.unitCny <= referenceMedian * Number(options.batchDiscountRatio ?? 0.7)
    const dropHit = previous?.unitCny !== undefined && listing.unitCny <= previous.unitCny * Number(options.priceDropRatio ?? 0.9)
    const alreadyAlertedAtPrice = priorAlert?.unitCny !== undefined && listing.unitCny >= priorAlert.unitCny
    if (!(priceHit || batchHit || dropHit) || alreadyAlertedAtPrice) continue
    const reasons = []
    if (priceHit) reasons.push(`到手单价不高于 ¥${roundMoney(thresholdCny)}`)
    if (batchHit) reasons.push('批量单价显著低于本次可信样本中位价')
    if (dropHit) reasons.push('同一货源价格较上次明显下降')
    alerts.push({
      key: listing.key,
      listing,
      reasons,
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
      requiresManualReview: listing.flags.some(flag => ['DAMAGED_OR_UNTESTED', 'NO_SSD', 'NO_RAM', 'NO_ADAPTER', 'CPU_UNKNOWN'].includes(flag)),
    })
  }
  return { alerts, referenceMedian: roundMoney(referenceMedian), trusted }
}

export function summarizeListings(listings, thresholdCny = 1500) {
  const trusted = listings.filter(item => isTrustedCandidate(item))
  const prices = trusted.map(item => item.unitCny).filter(Number.isFinite)
  return {
    total: listings.length,
    trusted: trusted.length,
    belowThreshold: trusted.filter(item => item.unitCny <= thresholdCny).length,
    minimumCny: prices.length ? roundMoney(Math.min(...prices)) : undefined,
    medianCny: roundMoney(median(prices)),
  }
}

export function parseJsonFeed(value, defaults = {}) {
  const rawItems = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.listings) ? value.listings : []
  return rawItems.map(item => ({ ...defaults, ...item }))
}

export function extractListingsFromHtml(html, sourceUrl) {
  const listings = []
  const scripts = [...String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  for (const match of scripts) {
    try {
      collectJsonLd(JSON.parse(match[1]), listings, sourceUrl)
    } catch {
      // Ignore malformed JSON-LD blocks and continue to the HTML fallback.
    }
  }
  listings.push(...extractEbayCards(html, sourceUrl))
  return dedupeRawListings(listings)
}

function collectJsonLd(node, output, sourceUrl) {
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLd(item, output, sourceUrl)
    return
  }
  if (!node || typeof node !== 'object') return
  if (node['@graph']) collectJsonLd(node['@graph'], output, sourceUrl)
  const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']]
  if (type.includes('ItemList') && Array.isArray(node.itemListElement)) {
    for (const entry of node.itemListElement) collectJsonLd(entry?.item ?? entry, output, sourceUrl)
  }
  if (type.includes('ListItem') && node.item) collectJsonLd(node.item, output, sourceUrl)
  if (type.includes('Product') || type.includes('IndividualProduct')) {
    const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers
    output.push({
      source: hostFromUrl(sourceUrl),
      sourceId: node.sku ?? node.productID ?? node.mpn,
      title: node.name,
      description: node.description,
      url: absoluteUrl(node.url ?? offers?.url, sourceUrl),
      price: offers?.price ?? offers?.lowPrice,
      currency: offers?.priceCurrency,
      condition: offers?.itemCondition ?? node.itemCondition,
      seller: offers?.seller?.name,
    })
  }
}

function extractEbayCards(html, sourceUrl) {
  const output = []
  const blocks = String(html).split(/<li\b[^>]*class=["'][^"']*\bs-item\b[^"']*["'][^>]*>/i).slice(1)
  for (const block of blocks) {
    const segment = block.split(/<\/li>/i)[0]
    const url = /<a\b[^>]*class=["'][^"']*\bs-item__link\b[^"']*["'][^>]*href=["']([^"']+)/i.exec(segment)?.[1]
      ?? /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bs-item__link\b/i.exec(segment)?.[1]
    const title = stripHtml(/<div\b[^>]*class=["'][^"']*\bs-item__title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(segment)?.[1]
      ?? /<span\b[^>]*role=["']heading["'][^>]*>([\s\S]*?)<\/span>/i.exec(segment)?.[1])
    const price = stripHtml(/<span\b[^>]*class=["'][^"']*\bs-item__price\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(segment)?.[1])
    const shipping = stripHtml(/<span\b[^>]*class=["'][^"']*\bs-item__shipping[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(segment)?.[1])
    if (!title || !price || !url) continue
    output.push({
      source: hostFromUrl(sourceUrl),
      sourceId: idFromUrl(url),
      title,
      url: absoluteUrl(url, sourceUrl),
      price,
      shipping,
    })
  }
  return output
}

function dedupeRawListings(listings) {
  const seen = new Set()
  const output = []
  for (const listing of listings) {
    const key = `${listing.sourceId ?? ''}|${listing.url ?? ''}|${normalizeText(listing.title)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(listing)
  }
  return output
}

export function safeJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'string' && item.length > 10_000 ? `${item.slice(0, 10_000)}…` : item)
}

function validIso(value) {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : undefined
}

function roundMoney(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined
}

function hostFromUrl(value) {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return undefined }
}

function idFromUrl(value) {
  try {
    const url = new URL(value)
    return /\/(?:itm|p)\/(?:[^/]+\/)?(\d{6,})/.exec(url.pathname)?.[1]
      ?? url.searchParams.get('item')
      ?? url.searchParams.get('id')
      ?? undefined
  } catch { return undefined }
}

function absoluteUrl(value, base) {
  try { return new URL(value, base).toString() } catch { return collapseWhitespace(value) }
}

function isSafeHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch { return false }
}
