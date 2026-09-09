import assert from 'node:assert/strict'
import test from 'node:test'

import { clearStaleDshAuthCookies, dshLoopbackCookieUrl } from '../src/dsh-session-cookies.js'

test('只为 DSH 本机地址生成 Cookie 维护范围', () => {
  assert.equal(dshLoopbackCookieUrl('http://127.0.0.1:49278/?token=secret'), 'http://127.0.0.1:49278/')
  assert.equal(dshLoopbackCookieUrl('http://localhost:3000/'), 'http://localhost:3000/')
  assert.equal(dshLoopbackCookieUrl('https://127.0.0.1:49278/'), undefined)
  assert.equal(dshLoopbackCookieUrl('http://example.com:49278/'), undefined)
  assert.equal(dshLoopbackCookieUrl('not-a-url'), undefined)
})

test('启动前只删除本机 DSH 认证 Cookie，不清理同会话其他数据', async () => {
  const removed: Array<{ url: string, name: string }> = []
  const count = await clearStaleDshAuthCookies({
    get: async ({ url }) => {
      assert.equal(url, 'http://127.0.0.1:49278/')
      return [{ name: 'dsh-auth-old-port' }, { name: 'unrelated-preference' }, { name: 'dsh-auth-current-port' }]
    },
    remove: async (url, name) => { removed.push({ url, name }) },
  }, 'http://127.0.0.1:49278/?token=fresh')
  assert.equal(count, 2)
  assert.deepEqual(removed, [
    { url: 'http://127.0.0.1:49278/', name: 'dsh-auth-old-port' },
    { url: 'http://127.0.0.1:49278/', name: 'dsh-auth-current-port' },
  ])
})

test('非本机地址不得读取或删除 Cookie', async () => {
  let touched = false
  const count = await clearStaleDshAuthCookies({
    get: async () => { touched = true; return [] },
    remove: async () => { touched = true },
  }, 'https://example.com/')
  assert.equal(count, 0)
  assert.equal(touched, false)
})
