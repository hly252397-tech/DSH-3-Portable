import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const archived = resolve('customizations/ui-tweaks/lib/client.js')
test('model icon is a theme-aware chip with an unchanged click target', () => {
  const source = readFileSync(archived, 'utf8')
  const start = source.indexOf("'.dsh-tweaks-model::before{")
  const end = source.indexOf('// 「调」', start)
  const block = source.slice(start, end)
  assert.ok(block.includes('mask-image:url('))
  assert.ok(block.includes('M6 1.5v2'))
  assert.ok(block.includes('background-color:var(--dsw-alias-label-secondary,CanvasText)'))
  assert.ok(block.includes('pointer-events:none!important'))
  const live = resolve('Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js')
  if (existsSync(live)) {
    const deployed = readFileSync(live, 'utf8')
    const liveStart = deployed.indexOf("'.dsh-tweaks-model::before{")
    assert.equal(deployed.slice(liveStart, deployed.indexOf('// 「调」', liveStart)).replace(/\r\n/g, '\n'), block.replace(/\r\n/g, '\n'))
  }
})
test('live-cost capsule styles target stable IDs and preserve quota states', () => {
  const source = readFileSync(archived, 'utf8')
  assert.ok(source.includes('body [data-testid="billing-live-cost-chip"]{'))
  assert.ok(source.includes('[data-testid="billing-live-tier"]'))
  assert.ok(source.includes('height:26px!important;min-height:26px!important'))
  assert.ok(source.includes(':is(.VWh0dG_feeInlineAlert,.VWh0dG_feeInlineError)::before'))
  assert.ok(source.includes('.VWh0dG_feeInlineError::before{background:var(--ds-red'))
  assert.ok(source.includes('font-variant-numeric:tabular-nums!important'))
})
test('live cost capsule rules match their recoverable archive', t => {
  const live = resolve('Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js')
  if (!existsSync(live)) return t.skip('Optional live Profile is not installed')
  // Other pre-existing live diagnostics differ from the archive and are not
  // owned by this visual change. Compare the complete new block, not the file.
  const block = (file: string) => {
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf('// Unified live-cost capsule:')
    const end = source.indexOf('// seat 容器承载', start)
    assert.ok(start >= 0 && end > start)
    return source.slice(start, end)
  }
  assert.equal(block(live), block(archived))
})
