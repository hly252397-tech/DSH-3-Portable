import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

test('repeated host bootstrap preserves theme controls while locale changes rebuild their labels', async () => {
  const source = await readFile(resolve('assets/settings.html'), 'utf8')
  const start = source.indexOf('function renderThemes(){')
  const end = source.indexOf('let themeSaving=', start)
  const node = () => ({ dataset: {}, style: {}, children: [] as unknown[], setAttribute() {}, addEventListener() {}, append(...items: unknown[]) { this.children.push(...items) } })
  const grid = { ...node(), replaceChildren() { this.children = [] } }
  let selected = 'qoder'
  let shown: string | undefined
  const context: Record<string, any> = {
    window: { DshThemes: true }, themeGrid: grid, themeOptions: [], locale: 'zh-CN',
    document: { createElement: node }, selectTheme() {}, selectThemeFromKey() {},
    isZh: () => context.locale.startsWith('zh'),
    setThemeChecked: (value: string) => { shown = value },
    DshThemes: { saved: () => selected, THEMES: { qoder: { zh: '工作台', en: 'Workbench', swatch: '#668877' }, lake: { zh: '湖蓝', en: 'Lake', swatch: '#0961f6' } } },
  }
  runInNewContext(source.slice(start, end), context)
  context.renderThemes()
  const button = grid.children[0]
  selected = 'lake'
  for (let count = 0; count < 30; count++) context.renderThemes()
  assert.equal(grid.children[0], button, 'host updates must not detach the active control')
  assert.equal(shown, 'lake')
  context.locale = 'en-US'
  context.renderThemes()
  assert.notEqual(grid.children[0], button)
  assert.equal(grid.children.length, 2)
})
