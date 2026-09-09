import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const owner = '@michengai/dsh-codex-ui'

test('reviewed Codex fork styles explicitly belong to their own plugin', async () => {
  const source = await readFile(join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js'), 'utf8')
  // The registry package can update independently. Portable appearance is owned
  // by assets/theme.css and verified against the actual registry UI in Electron.
  const styles = [...source.matchAll(/react_jsx_runtime\.jsxs?\)\("style", \{([^\n]*)/g)]
  assert.equal(styles.length, 9)
  for (const match of styles) assert.ok(match[1]!.includes(`"data-plugin": "${owner}"`))
  assert.match(source, /style.id = USER_BUBBLE_EXPAND_STYLE_ID;\s*style.dataset.plugin = "@michengai\/dsh-codex-ui"/)
  assert.match(source, /style.id = CONVERSATION_HEADER_STYLE_ID;\s*style.dataset.plugin = "@michengai\/dsh-codex-ui"/)
})

test('actual installed module loader cannot claim tagged sidebar styles for another plugin', async () => {
  const loaderSource = await readFile(join(process.cwd(), 'Data/Runtime/Harness/slots/0.1.2-alpha.5-cb08109a63a4f05b/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'), 'utf8')
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
