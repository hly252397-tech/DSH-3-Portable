import { collapseWhitespace, stripHtml } from './core.js'
import { fetchWithRetry } from './sources.js'

// kleinanzeigen.de（前 eBay Kleinanzeigen）公开搜索结果适配器。
// 只访问公开搜索页：无登录、无 Cookie、不重试轰炸；403 由 fetchWithRetry 判为 SOURCE_BLOCKED。
// 卡片结构（2026-09 实测）：<article data-adid data-href> 内嵌 ld+json ImageObject（title/description）
// + <p class="...text-title3...">1.300 €</p> 价格节点（德式千分位）。
export function createKleinanzeigenSourceAdapter() {
  return {
    id: 'kleinanzeigen',
    canHandle: url => url.protocol === 'https:' && url.hostname.toLocaleLowerCase().endsWith('kleinanzeigen.de'),
    async fetchListings(url, options = {}) {
      const response = await fetchWithRetry(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        userAgent: options.userAgent,
      })
      const html = await response.text()
      if (html.length > Number(options.maxBytes ?? 5_000_000)) {
        const error = new Error(`来源响应超过限制：${url.hostname}`)
        error.code = 'SOURCE_TOO_LARGE'
        error.retryable = true
        throw error
      }
      return { listings: extractKleinanzeigenCards(html, url.toString()) }
    },
  }
}

export function extractKleinanzeigenCards(html, sourceUrl) {
  const cards = [...String(html).matchAll(/<article\b[^>]*data-adid=["'](\d+)["'][^>]*>([\s\S]*?)<\/article>/gi)]
  const listings = []
  for (const [, adId, body] of cards) {
    const text = cardText(body)
    const href = /href=["'](\/s-anzeige\/[^"']+)["']/i.exec(body)?.[1]
    const title = metaTitle(body) ?? firstHeading(body)
    const price = priceFromCard(body, text)
    if (!adId || !title || price === undefined || !href) continue
    const url = absoluteUrl(href, sourceUrl)
    if (!url) continue
    listings.push({
      source: 'kleinanzeigen.de',
      sourceId: adId,
      title,
      description: metaDescription(body),
      url,
      price,
      shipping: shippingFromCard(text),
      currency: 'EUR',
      condition: 'used',
      seller: sellerFromCard(text),
      location: locationFromCard(text),
    })
  }
  return listings
}

function cardText(body) {
  return collapseWhitespace(String(body ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
}

function metaTitle(body) {
  for (const match of String(body).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const json = JSON.parse(match[1])
      if (typeof json?.title === 'string' && json.title.trim()) return collapseWhitespace(json.title)
    } catch {
      // 忽略无法解析的 ld+json 块，走标题回退。
    }
  }
  return undefined
}

function metaDescription(body) {
  for (const match of String(body).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const json = JSON.parse(match[1])
      if (typeof json?.description === 'string' && json.description.trim()) return collapseWhitespace(json.description)
    } catch {
      // 忽略无法解析的 ld+json 块。
    }
  }
  return ''
}

function firstHeading(body) {
  const match = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(String(body))
  const title = match ? stripHtml(match[1]) : ''
  return title || undefined
}

function priceFromCard(body, text) {
  const priceNode = /<p\b[^>]*class=["'][^"']*text-title3[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(String(body))
  const priceText = priceNode ? stripHtml(priceNode[1]) : /\d[\d.,]*\s*€/.exec(text)?.[0] ?? ''
  return parseGermanPrice(priceText)
}

function parseGermanPrice(text) {
  const cleaned = collapseWhitespace(String(text ?? '')).replace(/€/g, '').trim()
  if (!cleaned) return undefined
  if (/zu\s+verschenken|free|geschenk/i.test(cleaned)) return 0
  const raw = /\d[\d.,]*/.exec(cleaned)?.[0]
  if (!raw) return undefined
  let normalized = raw
  if (raw.includes(',')) {
    const [intPart, fracPart] = raw.split(',')
    normalized = `${intPart.replace(/\./g, '')}.${fracPart}`
  } else {
    normalized = raw.replace(/\./g, '')
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : undefined
}

function shippingFromCard(text) {
  const match = /Versand[^€<]{0,40}?(\d[\d.,]*)\s*€/i.exec(text)
  return match ? parseGermanPrice(match[1]) ?? 0 : 0
}

function sellerFromCard(text) {
  return collapseWhitespace(/\bPRO\s+([^\s].{1,40}?)(?:\s{2,}|$)/.exec(text)?.[1] ?? '')
}

function locationFromCard(text) {
  const match = /\b(\d{5}\s+[^\d].{2,60}?)(?=\s+\d{2}\.\d{2}\.\d{4})/.exec(text)
  return collapseWhitespace(match?.[1] ?? '')
}

function absoluteUrl(value, base) {
  try {
    const url = new URL(value, base)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch { return undefined }
}
