import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

// 实机产物在 Data/DSH/profiles 下，CI 全新检出没有 ⇒ 必须 existsSync 守卫 + skip。
const liveClient = 'Data/DSH/profiles/web/local/dsh-custom-spaces/lib/client.js'

test('custom spaces preserve full names and compact accessible icon controls', () => {
  const source = readFileSync('customizations/custom-spaces/lib/client.js', 'utf8')
  assert.ok(source.includes('.dcs-name{flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere}'))
  assert.ok(source.includes('.dcu-compact .dcs-title,.dcu-compact .dcs-name,.dcu-compact .dcs-empty{display:none}'))
  assert.ok(source.includes('.dcu-compact .dcs-item{width:36px;height:36px;'))
  assert.ok(source.includes('"aria-label": space.name || space.url'))
  assert.ok(source.includes('title: (space.name ? `${space.name}\\n${space.url}` : space.url)'))
  assert.ok(source.includes('sidecard.openTab({ type: "browser", url, title: space.name || url })'))
})

test('custom spaces precede billing through native slot ordering, with separator below', (t) => {
  const source = readFileSync('customizations/custom-spaces/lib/client.js', 'utf8')
  if (!existsSync(liveClient)) {
    // CI 全新检出无 Data/；实机上该目录 2026-09-26 起已改名为 dsh-custom-spaces.disabled/（副本已停用，与归档件不同步）。
    t.skip(`实机产物缺失（CI 全新检出或已停用为 .disabled）: ${liveClient}`)
    return
  }
  const live = readFileSync(liveClient, 'utf8')
  assert.equal(source.replace(/\r\n/g, '\n'), live.replace(/\r\n/g, '\n'))
  assert.match(source, /id: "custom-spaces-entry",\s*order: -100/)
  assert.ok(source.includes('padding:2px 4px 6px;border-bottom:1px solid'))
  assert.ok(source.includes('.dcu-compact .dcs-group{padding:0 0 8px;'))
  assert.doesNotMatch(source, /column-reverse|row-reverse/)
  assert.ok(source.includes('justify-content:center;background:transparent;color:var(--dcu-sidebar-icon,#52525b)'))
  assert.ok(source.includes('.dcu-compact .dcs-icon{color:inherit;background:transparent}'))
  assert.ok(source.includes('.dcu-compact .dcs-item:hover{background:var(--dcu-sidebar-hover,#f4f4f5)'))
})
