import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { isLoopbackFaviconRequest, pngDataUrl } from '../src/window-icon.js'

test('窗口任务栏保留高清原图，不把全部尺寸登记为同一个 1x 位图', async () => {
  const source = await readFile(resolve('src/main.ts'), 'utf8')
  const implementation = source.slice(source.indexOf('function resolveWindowIconImage()'), source.indexOf('function installDesktopFaviconReplacement()'))
  assert.match(implementation, /cachedWindowIcon = compactSource\.isEmpty\(\) \? source : compactSource/)
  assert.doesNotMatch(implementation, /addRepresentation\(/)
  assert.doesNotMatch(implementation, /\.resize\(/)
})

test('只拦截本机页面的 favicon 请求', () => {
  assert.equal(isLoopbackFaviconRequest('http://127.0.0.1:1234/favicon.ico'), true)
  assert.equal(isLoopbackFaviconRequest('http://localhost:8080/favicon.png'), true)
  assert.equal(isLoopbackFaviconRequest('http://[::1]/favicon.ico'), true)
  assert.equal(isLoopbackFaviconRequest('https://example.com/favicon.ico'), false)
  assert.equal(isLoopbackFaviconRequest('http://127.0.0.1:1234/api/icon'), false)
})

test('PNG 可以转成 data URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-favicon-'))
  try {
    const file = join(root, 'icon.png')
    await writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    assert.equal(pngDataUrl(file)?.startsWith('data:image/png;base64,'), true)
    assert.equal(pngDataUrl(join(root, 'missing.png')), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
