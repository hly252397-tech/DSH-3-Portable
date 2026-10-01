import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('staging metadata preserves upstream tarball URL, integrity and signatures byte for byte', async () => {
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(body)
  })
  let body = ''
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  body = JSON.stringify({ name: 'fixture', versions: { '1.0.0': { dist: { tarball: `${url}/fixture/-/fixture-1.0.0.tgz`, integrity: 'sha512-proof', signatures: [{ keyid: 'key', sig: 'proof' }] } } } })
  const { startStagingRegistryProxy } = await import(pathToFileURL(resolve('scripts/staging-registry-proxy.mjs')).href)
  const proxy = await startStagingRegistryProxy({ upstream: url, port: 0 })
  try { assert.equal(await (await fetch(proxy.url + '/fixture')).text(), body) }
  finally { await proxy.close(); await new Promise<void>((resolve, reject) => upstream.close(e => e ? reject(e) : resolve())) }
})
