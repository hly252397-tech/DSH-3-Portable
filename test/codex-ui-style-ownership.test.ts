import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const owner = '@michengai/dsh-codex-ui'
// 前两条用例读取实机 profile 产物与历史运行时槽；全新检出（如 CI）没有这些文件时跳过。
const liveClientPath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js')
const liveLoaderPath = join(process.cwd(), 'Data/Runtime/Harness/slots/0.1.2-alpha.5-cb08109a63a4f05b/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js')

test('reviewed Codex fork styles explicitly belong to their own plugin', async t => {
  if (!existsSync(liveClientPath)) return t.skip('实机 codex-ui 产物缺失（CI 全新检出）')
  const source = await readFile(liveClientPath, 'utf8')
  // The registry package can update independently. Portable appearance is owned
  // by assets/theme.css and verified against the actual registry UI in Electron.
  const styles = [...source.matchAll(/react_jsx_runtime\.jsxs?\)\("style", \{([^\n]*)/g)]
  assert.equal(styles.length, 9)
  for (const match of styles) assert.ok(match[1]!.includes(`"data-plugin": "${owner}"`))
  assert.match(source, /style.id = USER_BUBBLE_EXPAND_STYLE_ID;\s*style.dataset.plugin = "@michengai\/dsh-codex-ui"/)
  assert.match(source, /style.id = CONVERSATION_HEADER_STYLE_ID;\s*style.dataset.plugin = "@michengai\/dsh-codex-ui"/)
})

test('actual installed module loader cannot claim tagged sidebar styles for another plugin', async t => {
  if (!existsSync(liveLoaderPath)) return t.skip('实机历史运行时槽缺失（CI 全新检出）')
  const loaderSource = await readFile(liveLoaderPath, 'utf8')
  const start = loaderSource.indexOf('const claimStyles = (id) => {')
  const end = loaderSource.indexOf('\n\t\t};', start)
  assert.ok(start >= 0 && end > start)
  const makeStyle = (plugin?: string) => ({
    plugin,
    setAttribute(name: string, value: string) { if (name === 'data-plugin') this.plugin = value },
    getAttribute() { return null },
  })
  const tagged = makeStyle(owner), legacy = makeStyle()
  const styles = [tagged, legacy]
  const claim = runInNewContext(`${loaderSource.slice(start, end + 6)}; claimStyles`, {
    document: {
      querySelectorAll(selector: string) {
        if (selector === 'style:not([data-plugin])') return styles.filter(style => !style.plugin)
        const id = JSON.parse(selector.slice('style[data-plugin='.length, -1))
        return styles.filter(style => style.plugin === id)
      },
    },
  })
  const claimed = claim('dsh-sidebar-spaces')
  assert.equal(tagged.plugin, owner)
  assert.equal(legacy.plugin, 'dsh-sidebar-spaces', 'reproduces the untagged-style ownership bug')
  assert.equal(claimed.length, 1)
  assert.equal(claim(owner).length, 1)
})

test('主题层把 codex-ui ≥1.1 的完整侧栏变量组钉进便携浅色调色板', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  const blockStart = css.indexOf('body[data-color-scheme="light"] .dcu-root')
  assert.ok(blockStart >= 0, 'theme.css 必须保留浅色 .dcu-root 覆盖块')
  const blockEnd = css.indexOf('}', css.indexOf('--dcu-sidebar-icon', blockStart))
  const block = css.slice(blockStart, blockEnd)
  // codex-ui ≥1.1 侧栏与设置页导航直接引用 --dcu-sidebar-*（默认 #eef7f5 淡绿）；
  // 任一变量缺失都会让对应区域回退上游默认色（2026-09-11 设置页左栏实际复发）。
  for (const variable of ['--dcu-sidebar-background', '--dcu-sidebar-hover', '--dcu-sidebar-border',
    '--dcu-sidebar-primary', '--dcu-sidebar-secondary', '--dcu-sidebar-tertiary',
    '--dcu-sidebar-navigation', '--dcu-sidebar-icon']) {
    assert.ok(block.includes(variable), `${variable} 未被钉住，codex-ui 更新后会回退默认配色`)
  }
  assert.match(block, /--dcu-sidebar-background:\s*#ffffff/)
})
