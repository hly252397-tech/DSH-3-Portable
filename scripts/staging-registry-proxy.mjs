import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'

function scanPrefetch(prefetchDir) {
  const tarballs = new Map()
  if (!existsSync(prefetchDir)) return tarballs
  for (const name of readdirSync(prefetchDir)) {
    const path = join(prefetchDir, name)
    if (!statSync(path).isFile() || !name.endsWith('.tgz')) continue
    const m = name.match(/^(.+)-(\d+\.\d+.*)\.tgz$/)
    if (!m) continue
    const pkgName = m[1]
    const version = m[2]
    const key = `${pkgName}/${version}`
    tarballs.set(key, { path, name, pkgName, version, size: statSync(path).size })
  }
  return tarballs
}

function sha256Base64(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', c => hash.update(c))
    s.on('end', () => resolve(hash.digest('base64')))
    s.on('error', reject)
  })
}

function cleanHeaders(upstreamHeaders) {
  const headers = Object.fromEntries(upstreamHeaders)
  delete headers['content-encoding']
  delete headers['content-length']
  delete headers['transfer-encoding']
  return headers
}

/**
 * @typedef {object} ProxyOptions
 * @property {string} [prefetchDir]
 * @property {string} [upstream]
 * @property {string} [host]
 * @property {number} [port]
 *
 * @typedef {object} ProxyHandle
 * @property {string} url
 * @property {() => Promise<void>} close
 */

/** @param {ProxyOptions} options @returns {Promise<ProxyHandle>} */
export async function startStagingRegistryProxy(options = {}) {
  const prefetchDir = options.prefetchDir || join(process.cwd(), 'Data', 'Temp', 'prefetch')
  const upstream = options.upstream || process.env.DSH_UPSTREAM_REGISTRY || 'https://registry.npmmirror.com/'
  const host = options.host || process.env.DSH_PROXY_HOST || '127.0.0.1'
  const port = options.port ?? Number(process.env.DSH_PROXY_PORT || 0)
  const upstreamBase = upstream.replace(/\/$/, '')
  const tarballs = scanPrefetch(prefetchDir)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const startTime = Date.now()
    const log = (status, extra = '') => {
      const elapsed = Date.now() - startTime
      console.log(`[proxy] ${req.method} ${url.pathname}${url.search} -> ${status} (${elapsed}ms)${extra}`)
    }

    const scopeParts = url.pathname.split('/-/')
    if (scopeParts.length === 2) {
      const packagePath = scopeParts[0]
      const tarballName = scopeParts[1]
      const versionMatch = tarballName.match(/-((?:\d+\.)+\d+[^-]*)\.tgz$/)
      if (versionMatch) {
        const escapedName = packagePath.replace(/^\//, '').replace(/\//g, '-')
        const version = versionMatch[1]
        const key = `${escapedName}/${version}`
        const local = tarballs.get(key)
        if (local) {
          try {
            const integrity = await sha256Base64(local.path)
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': String(local.size),
              'content-disposition': `attachment; filename="${local.name}"`,
              'x-local-prefetch': 'true',
              'x-sha256': integrity,
            })
            createReadStream(local.path).pipe(res)
            log(200, ` local ${local.name}`)
            return
          } catch (err) {
            log(502, ` local-error ${err.message}`)
            res.writeHead(502, { 'content-type': 'text/plain' })
            res.end(`proxy local error: ${err.message}`)
            return
          }
        }
      }
    }

    const abortController = new AbortController()
    const onClientClose = () => {
      abortController.abort()
    }
    req.once('close', onClientClose)
    res.once('close', onClientClose)

    try {
      const upstreamUrl = upstreamBase + url.pathname + url.search
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        signal: abortController.signal,
        headers: { accept: req.headers.accept || '*/*', 'user-agent': 'dsh-staging-proxy', 'accept-encoding': 'identity' },
      })
      const contentType = upstreamRes.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const body = await upstreamRes.text()
        const rewritten = body.replaceAll(`${upstreamBase}/`, `${server.url}/`)
        const headers = cleanHeaders(upstreamRes.headers)
        headers['content-length'] = String(Buffer.byteLength(rewritten))
        res.writeHead(upstreamRes.status, headers)
        res.end(rewritten)
        log(upstreamRes.status, ' json')
        return
      }
      const headers = cleanHeaders(upstreamRes.headers)
      res.writeHead(upstreamRes.status, headers)
      const upstreamReadable = Readable.fromWeb(upstreamRes.body)
      upstreamReadable.pipe(res)
      await new Promise((resolve, reject) => {
        upstreamReadable.once('error', reject)
        res.once('error', reject)
        res.once('finish', resolve)
      })
      log(upstreamRes.status, ' stream')
    } catch (err) {
      if (abortController.signal.aborted) {
        log(499, ' client-aborted')
        if (!res.headersSent) {
          res.writeHead(499, { 'content-type': 'text/plain' })
          res.end('client closed request')
        }
        return
      }
      log(502, ` error ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`proxy error: ${err.message}`)
      }
    } finally {
      req.removeListener('close', onClientClose)
      res.removeListener('close', onClientClose)
    }
  })

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address()
      const url = `http://${addr.address}:${addr.port}`
      server.url = url
      console.log(`DSH staging registry proxy listening on ${url}`)
      console.log(`Upstream registry: ${upstream}`)
      console.log(`Prefetched tarballs available: ${tarballs.size}`)
      resolve({
        url,
        close: () => new Promise((res, rej) => server.close(err => err ? rej(err) : res())),
      })
    })
    server.once('error', reject)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStagingRegistryProxy()
}
