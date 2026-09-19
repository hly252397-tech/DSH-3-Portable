import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const pluginDir = new URL('../../Data/DSH/profiles/web/local/dsh-agent-discipline/', import.meta.url)
const profileManifest = new URL('../../Data/DSH/profiles/web/package.json', import.meta.url)

// 止损纪律插件：把「每轮必守」的六条纪律做成 systemPrompt 节，压缩免疫。
// 实机产物在 Data/DSH/profiles 下，CI 全新检出没有 ⇒ 必须 existsSync 守卫 + skip。
test('止损纪律插件注册 systemPrompt 节，且可配置、可停用', async (t) => {
  const entry = new URL('lib/index.js', pluginDir)
  if (!existsSync(entry)) {
    t.skip('实机插件产物缺失（CI 全新检出）')
    return
  }
  const mod = (await import(entry.href)) as any
  assert.equal(mod.name, 'dsh-agent-discipline')
  assert.deepEqual(mod.inject, ['systemPrompt'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.Config, 'function')

  const sections: any[] = []
  const ctx = { systemPrompt: { section: (value: unknown) => { sections.push(value) } } }
  mod.apply(ctx, mod.Config({}))
  assert.equal(sections.length, 1, '默认配置应注册恰好一个节')
  assert.equal(sections[0].name, 'discipline:stop-loss')
  assert.equal(sections[0].order, 40)
  const text = String(sections[0].text({}))
  for (const marker of ['对照复现', '候选槽就绪 ≠ 完成', '受保护清单', 'AGENTS.md']) {
    assert.ok(text.includes(marker), `注入文本缺少关键约束：${marker}`)
  }
  assert.equal((text.match(/^\d\. /gm) ?? []).length, 6, '注入文本应含六条编号纪律')

  const disabled: any[] = []
  mod.apply({ systemPrompt: { section: (value: unknown) => { disabled.push(value) } } }, mod.Config({ enabled: false }))
  assert.equal(disabled.length, 0, 'enabled:false 时不得注册')

  const customised: any[] = []
  mod.apply({ systemPrompt: { section: (value: unknown) => { customised.push(value) } } }, mod.Config({ order: 7, extra: '补充：写操作先给用户过目。' }))
  assert.equal(customised[0].order, 7, 'order 必须可由配置覆盖')
  assert.ok(String(customised[0].text({})).includes('写操作先给用户过目'), 'extra 必须进入注入文本')
})

test('止损纪律插件按仓库约定登记进 profile 清单并自包含制品', async (t) => {
  if (!existsSync(profileManifest)) {
    t.skip('实机 profile 缺失（CI 全新检出）')
    return
  }
  const manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
  assert.match(String(manifest.dependencies?.['dsh-agent-discipline'] ?? ''), /^link:/, '必须以 link: 声明（目录链接，非拷贝）')
  assert.ok(Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes('dsh-agent-discipline'), '必须进 dsh.profile.bundles 才会被加载')

  const pkg = JSON.parse(await readFile(new URL('package.json', pluginDir), 'utf8'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(pkg.files?.includes('lib/index.js') && pkg.files?.includes('cordis.patch.yml'), 'files 必须包含 ESM 入口与 patch')
  assert.ok(existsSync(new URL('cordis.patch.yml', pluginDir)), 'patch 文件必须存在')

  const patch = await readFile(new URL('cordis.patch.yml', pluginDir), 'utf8')
  assert.match(patch, /id:\s*agent-discipline/, 'patch 条目必须有稳定 id（loader 按 id 做增量更新）')
  assert.match(patch, /name:\s*dsh-agent-discipline/, 'patch 条目按包名引用')
})
