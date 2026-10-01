import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

// 实机产物在 Data/DSH/profiles 下，CI 全新检出没有 ⇒ 必须 existsSync 守卫 + skip。
const liveFile = (name: string) => `Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/${name}`

test('customized workspace composer uses one border and retains focus feedback', (t) => {
  const files = ['client.src.js', 'client.js']
  const missing = files.filter(file => !existsSync(liveFile(file)))
  if (missing.length) {
    t.skip(`实机产物缺失（CI 全新检出）: ${missing.map(liveFile).join(', ')}`)
    return
  }
  for (const file of files) {
    const source = readFileSync(liveFile(file), 'utf8')
    const block = source.split('/* I023/54:')[1]?.split('/* End I023/54 composer border. */')[0]
    assert.ok(block, file)
    assert.match(block, /body \[data-composer-card\]\.uV2eYG_cardWorkspaceTrigger::after\s*\{\s*content: none;\s*\}/)
    assert.match(block, /uV2eYG_cardWorkspaceTrigger:hover\s*\{\s*border-color:/)
    assert.match(block, /uV2eYG_cardWorkspaceTrigger:focus-within\s*\{\s*border-color: var\(--dsw-alias-state-business-primary/)
    assert.doesNotMatch(block, /pointer-events|display:\s*none|outline:\s*none/)
  }
})
