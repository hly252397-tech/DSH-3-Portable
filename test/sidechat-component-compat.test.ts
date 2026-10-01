import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import test from 'node:test'

const root = process.cwd()
const { transformSidechatComponentCompat: transform } = await import(
  pathToFileURL(join(root, 'scripts/sidechat-component-compat.mjs')).href
) as { transformSidechatComponentCompat: (source: string, target?: string) => string }
const { activeUiProfile } = await import(pathToFileURL(join(root, 'scripts/lib/active-ui-profile.mjs')).href)
const oldReference = '_deepseek_ai_dsh_client_ui_primitives.IconSendOutline16'
const newReference = '_deepseek_ai_dsh_client_ui_primitives.IconSendOutline14'
const original = `const untouched = '中文';\nconst send = jsx(${oldReference}, {});\n`
const expected = `const untouched = '中文';\nconst send = jsx(${newReference}, { size: 16 });\n`

test('sidechat component transform changes only the send icon and keeps 16px sizing', () => {
  assert.equal(transform(original), expected)
  assert.doesNotThrow(() => new Script(transform(original)))
  const crlf = original.replaceAll('\n', '\r\n')
  assert.equal(transform(crlf), expected.replaceAll('\n', '\r\n'))
})

test('sidechat component transform is idempotent', () => {
  assert.equal(transform(transform(original)), expected)
  assert.equal(transform(expected), expected)
})

test('rc.2 send icon conversion retains size and rejects mixed generation anchors', () => {
  const regular = expected.replace('IconSendOutline14', 'IconSendOutlineRegular')
  assert.equal(transform(original, 'IconSendOutlineRegular'), regular)
  assert.equal(transform(expected, 'IconSendOutlineRegular'), regular)
  assert.equal(transform(regular, 'IconSendOutlineRegular'), regular)
  assert.equal(transform(regular), regular, 'existing bundle rebuild must not downgrade rc.2 icons')
  for (const bad of [regular + expected, regular + original, regular + regular, regular.replace('size: 16', 'size: 14')]) {
    assert.throws(() => transform(bad, 'IconSendOutlineRegular'), /anchor changed or is not unique/)
  }
})

test('sidechat component transform rejects absent, duplicate and mixed anchors', () => {
  for (const source of ['', 'const unrelated = 1;', original + original, expected + expected, original + expected]) {
    assert.throws(() => transform(source), /anchor changed or is not unique/)
  }
})

test('sidechat component transform rejects changed props and leftover references', () => {
  for (const source of [
    original.replace(', {}', ', { size: 20 }'),
    expected.replace('size: 16', 'size: 14'),
    original + `\nconst extra = ${oldReference};`,
    expected + `\nconst extra = ${newReference};`,
  ]) assert.throws(() => transform(source), /anchor changed or is not unique/)
  assert.throws(() => transform(null as unknown as string), TypeError)
})

test('sidechat source uses the supported send icon with explicit size', async t => {
  const file = join(root, 'Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/SideChatView.tsx')
  if (!existsSync(file)) return t.skip('实机插件源码缺失（CI 全新检出）')
  const source = await readFile(file, 'utf8')
  assert.match(source, /\bIconSendOutline14,/)
  assert.match(source, /<IconSendOutline14 size=\{16\} \/>/)
  assert.doesNotMatch(source, /\bIconSendOutline16\b/)
})

test('sidechat imports and converted live bundle match actual active runtime exports', async t => {
  const pointerFile = join(root, 'Data/Runtime/Harness/current.json')
  const active = activeUiProfile(root)
  const plugin = join(active.profile, 'local/dsh-better-sidebar')
  const sourceFile = join(plugin, 'src/client/SideChatView.tsx')
  const clientFile = join(plugin, 'lib/client.js')
  if (![pointerFile, sourceFile, clientFile].every(existsSync)) {
    return t.skip('实机运行时或插件产物缺失（CI 全新检出）')
  }
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'))
  assert.equal(typeof pointer.current?.relativePath, 'string', 'active runtime pointer must have a path')
  const runtimeFile = join(root, 'Data/Runtime', pointer.current.relativePath,
    'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js')
  assert.ok(existsSync(runtimeFile), 'active runtime primitive bundle must exist')
  const runtime = await readFile(runtimeFile, 'utf8')
  const exports = new Set<string>()
  const exportTables = [...runtime.matchAll(/^export\s*\{([^}]+)\}\s*;/gm)]
  assert.ok(exportTables.length > 0, 'runtime must expose a readable named export table')
  for (const [, table] of exportTables) {
    for (const entry of table.split(',')) {
      const name = entry.trim().split(/\s+as\s+/).at(-1)!
      assert.match(name, /^[A-Za-z_$][\w$]*$/, 'review changed export table syntax')
      exports.add(name)
    }
  }
  const target = exports.has('IconSendOutlineRegular') ? 'IconSendOutlineRegular' : 'IconSendOutline14'
  assert.ok(exports.has(target), 'replacement must be a real runtime export')
  const source = await readFile(sourceFile, 'utf8')
  const imports = [...source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/g)]
  assert.equal(imports.length, 1, 'review changed primitives import syntax')
  let importsChecked = 0
  for (const [, bindings] of imports) {
    for (const entry of bindings.split(',').map(value => value.trim()).filter(Boolean)) {
      if (/^type\s/.test(entry)) continue
      const name = entry.split(/\s+as\s+/)[0]
      assert.match(name, /^[A-Za-z_$][\w$]*$/, 'review changed import syntax')
      assert.ok(exports.has(name), `SideChatView import ${name} must exist in the active runtime`)
      importsChecked++
    }
  }
  assert.ok(importsChecked >= 7, 'must inspect the actual component imports')
  const client = await readFile(clientFile, 'utf8')
  const converted = transform(client, target)
  assert.equal(converted, client, 'active bundle must already be converted, not only a hypothetical transform')
  assert.equal(transform(converted, target), converted)
  assert.doesNotThrow(() => new Script(converted))
  const references = [...converted.matchAll(/_deepseek_ai_dsh_client_ui_primitives\.([A-Za-z0-9_$]+)/g)]
  assert.ok(references.length > 0, 'must inspect the actual generated client references')
  for (const [, name] of references) assert.ok(exports.has(name), `client primitive ${name} must exist in the active runtime`)
})
