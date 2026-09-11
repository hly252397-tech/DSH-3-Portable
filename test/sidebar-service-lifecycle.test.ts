import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const haveLiveProfile = existsSync(join(process.cwd(), 'Data/DSH/profiles/web/package.json'))

test('the portable Profile retains the sidebar cards provider alongside the Codex navigation', async t => {
  if (!haveLiveProfile) return t.skip('实机 profile 缺失（CI 全新检出）')
  const profile = join(process.cwd(), 'Data/DSH/profiles/web')
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  for (const name of ['dsh-better-sidebar', '@michengai/dsh-codex-ui']) {
    assert.ok(manifest.dependencies[name], `${name} must remain installed`)
    assert.ok(manifest.dsh.profile.bundles.includes(name), `${name} must remain enabled`)
  }
  const sidebar = JSON.parse(await readFile(join(profile, 'node_modules/dsh-better-sidebar/package.json'), 'utf8'))
  assert.ok(sidebar.dsh.bundle.patch)
  assert.ok(sidebar.exports['./client'], 'restoring only the backend does not restore cards')
})

test('companion cards register when the sidebar loads later and recover after reload', async t => {
  const runtime = resolveActiveRuntimeDir(join(process.cwd(), 'Data/Runtime/dsh-runtime'))
  if (runtime === undefined || !existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'))) return t.skip('实机运行时槽缺失（CI 全新检出）')
  const { Context } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
  const source = await readFile(join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js'), 'utf8')
  let connect: any
  runInNewContext(source.replace('exports.apply = apply;', 'exports.connect = withBetterSidebar; exports.apply = apply;'), {
    window: { __ModuleLoader__: { load(def: any) { connect = def.factory(() => ({})).connect } } },
  })
  const ctx = new Context()
  let mounts = 0, cleanups = 0
  const consumer = ctx.plugin({ name: 'test-companion', apply(inner: any) {
    inner.effect(() => connect(inner, (service: any) => {
      assert.equal(service.kind, 'sidebar')
      mounts++
      return () => { cleanups++ }
    }), 'test companion registration')
  } })
  let provider: any
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(predicate(), 'service lifecycle should settle')
  }
  try {
    await consumer
    assert.equal(mounts, 0)
    provider = ctx.plugin({ name: 'test-sidebar', apply(inner: any) { inner.provide('betterSidebar', { kind: 'sidebar' }) } })
    await provider
    await waitFor(() => mounts === 1)
    await provider.dispose()
    await waitFor(() => cleanups === 1)
    provider = ctx.plugin({ name: 'test-sidebar-reloaded', apply(inner: any) { inner.provide('betterSidebar', { kind: 'sidebar' }) } })
    await provider
    await waitFor(() => mounts === 2)
    await consumer.dispose()
    assert.equal(cleanups, 2)
  } finally {
    await consumer.dispose()
    if (provider) await provider.dispose()
  }
})
