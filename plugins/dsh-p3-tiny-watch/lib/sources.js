import { extractListingsFromHtml, parseJsonFeed } from './core.js'

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
]

export async function collectFromSources(sourceUrls, options = {}) {
  const listings = []
  const errors = []
  const allowlist = normalizeAllowlist(options.allowlist)
  for (const sourceUrl of sourceUrls) {
    try {
      const url = validateSourceUrl(sourceUrl, allowlist)
      const response = await fetchWithRetry(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        userAgent: options.userAgent,
      })
      const contentType = response.headers.get('content-type') ?? ''
      const text = await response.text()
      if (text.length > Number(options.maxBytes ?? 5_000_000)) {
        throw codedError('SOURCE_TOO_LARGE', `来源响应超过限制：${url.hostname}`)
      }
      if (/json/i.test(contentType) || looksLikeJson(text)) {
        let json
        try { json = JSON.parse(text) } catch { throw codedError('INVALID_RESPONSE', `来源返回了无法解析的 JSON：${url.hostname}`) }
        listings.push(...parseJsonFeed(json, { source: url.hostname, capturedAt: new Date().toISOString() }))
      } else {
        listings.push(...extractListingsFromHtml(text, url.toString()))
      }
    } catch (error) {
      errors.push({
        source: String(sourceUrl),
        code: error?.code ?? 'SOURCE_ERROR',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { listings, errors }
}

export function validateSourceUrl(value, allowlist = []) {
  let url
  try { url = new URL(String(value)) } catch { throw codedError('CONFIG_ERROR', `无效来源 URL：${value}`) }
  if (url.protocol !== 'https:') throw codedError('CONFIG_ERROR', `只允许 HTTPS 来源：${url.toString()}`)
  const hostname = url.hostname.toLocaleLowerCase()
  if (PRIVATE_HOST_PATTERNS.some(pattern => pattern.test(hostname))) {
    throw codedError('CONFIG_ERROR', `拒绝访问本机或内网地址：${hostname}`)
  }
  if (allowlist.length && !allowlist.some(item => hostname === item || hostname.endsWith(`.${item}`))) {
    throw codedError('CONFIG_ERROR', `来源域名不在允许列表：${hostname}`)
  }
  return url
}

export async function fetchWithRetry(url, options = {}) {
  const retries = Math.max(0, Math.min(2, Number(options.retries ?? 1)))
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const signal = combineSignals(options.signal, AbortSignal.timeout(Math.max(1_000, Number(options.timeoutMs ?? 30_000))))
      const response = await fetch(url, {
        redirect: 'follow',
        signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'user-agent': options.userAgent ?? 'DSH-P3-Tiny-Watch/0.1 (+local price monitor)',
        },
      })
      if (response.ok) return response
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 429) throw codedError('RATE_LIMIT', `来源限流（HTTP 429）：${url.hostname}`)
      if (response.status >= 500) throw codedError('UPSTREAM_ERROR', `来源暂时不可用（HTTP ${response.status}）：${url.hostname}`)
      throw codedError('UPSTREAM_ERROR', `来源请求失败（HTTP ${response.status}）：${url.hostname}`, false)
    } catch (error) {
      lastError = normalizeFetchError(error, url)
      if (attempt >= retries || lastError.retryable === false) break
      await sleep(800 * (attempt + 1), options.signal)
    }
  }
  throw lastError
}

function normalizeAllowlist(value) {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item).trim().toLocaleLowerCase().replace(/^\./, '')).filter(Boolean)
}

function looksLikeJson(text) {
  const trimmed = text.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function combineSignals(...signals) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

function normalizeFetchError(error, url) {
  if (error?.code) return error
  if (error?.name === 'TimeoutError') return codedError('TIMEOUT', `来源请求超时：${url.hostname}`)
  if (error?.name === 'AbortError') return codedError('CANCELLED', '检查已取消。', false)
  return codedError('NETWORK_ERROR', `无法连接来源 ${url.hostname}：${error instanceof Error ? error.message : String(error)}`)
}

function codedError(code, message, retryable = true) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}

async function sleep(delay, signal) {
  if (signal?.aborted) throw codedError('CANCELLED', '检查已取消。', false)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay)
    const abort = () => {
      clearTimeout(timer)
      reject(codedError('CANCELLED', '检查已取消。', false))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
