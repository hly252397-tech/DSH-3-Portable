import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const plugin = resolve('Data/DSH/profiles/web/local/dsh-agent-bridge/lib/index.js')
const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))

test('agent bridge reaches ACTIVE rather than waiting for the built-in logger', async t => {
  if (!runtime || !existsSync(plugin)) return t.skip('实机插件/运行时缺失（CI 全新检出）')
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const loaderFiber = ctx.plugin(Loader)
  try {
    await loaderFiber
    // 夹具补丁（2026-09-21）：该插件合法声明 `inject = ['logger']`，且 apply 开头就 `ctx.logger(name)`。
    // 裸 Context 不提供 logger 会让它永远停在 PENDING(0) —— 那是**夹具缺服务**，不是插件缺陷。
    // 对照实验证据：不提供 logger → state 0 PENDING；提供最小 logger → state 2 ACTIVE 且 apply 被调用。
    // 断言保持不变（仍要求 ACTIVE）；被守住的原意是"插件不得卡在 PENDING"，而不是"插件不得声明 inject"。
    ctx.provide('logger', Object.assign(
      () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} }),
      { info() {}, warn() {}, error() {}, debug() {} },
    ))
    ctx.provide('sessionController', {})
    const loader = ctx.get('loader')
    await loader.create({ id: 'agent-bridge', name: pathToFileURL(plugin).href, config: { port: 0 } })
    await loader.await()
    assert.equal(loader.resolve('agent-bridge').fiber.state, 2, 'plugin must become ACTIVE, not PENDING')
  } finally {
    await loaderFiber.dispose()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
