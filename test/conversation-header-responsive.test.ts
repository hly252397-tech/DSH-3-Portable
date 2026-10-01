import assert from 'node:assert/strict'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script, runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync('customizations/ui-tweaks/lib/client.js', 'utf8')
function clientCss(client: string): string {
  assert.doesNotThrow(() => new Script(client))
  const expression = client.match(/const CSS = (\[[\s\S]*?\]\.join\(''\));/)
  assert.ok(expression, 'UI client CSS bundle is missing')
  const css = runInNewContext(expression[1]!) as unknown
  assert.equal(typeof css, 'string')
  return css as string
}
function assertWideHeader(css: string): void {
  assert.match(css, /headerActions\{height:auto!important;min-height:28px;min-width:0;flex-wrap:wrap/)
  assert.match(css, /\.ZKlsPq_trigger\{flex-shrink:0;white-space:nowrap\}/)
  assert.match(css, /grid-template-columns:minmax\(0,max-content\) minmax\(0,1fr\) auto!important/)
}
function assertNarrowHeader(css: string): void {
  assert.ok(css.includes('@container dss-conversation (max-width:520px)'), 'Narrow conversation container rule is missing')
  const narrow = css.slice(css.indexOf('@container dss-conversation (max-width:520px)'))
  assert.match(narrow, /headerActions\{grid-row:2!important;grid-column:1 \/ -1!important\}/)
  assert.match(narrow, /\[data-dcu-inline-tabs\]\{grid-row:3!important;grid-column:1 \/ -1!important\}/)
  assert.doesNotMatch(css, /\.ZKlsPq_trigger\{[^}]*display:none/)
}
const css = clientCss(source)
test('header status groups wrap as units and escape the old 76px track', () => assertWideHeader(css))
test('narrow conversation columns give tabs their own row without hiding actions', () => assertNarrowHeader(css))
test('active generation independently retains the responsive header contract', async t => {
  try {
    const data = lstatSync(resolve('Data'))
    assert.ok(data.isDirectory() && !data.isSymbolicLink(), 'Data must be an ordinary portable directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('Portable Data absent (CI fresh checkout); canonical header tests remain mandatory')
    throw error
  }
  const { activeUiProfile } = await import(pathToFileURL(resolve('scripts/lib/active-ui-profile.mjs')).href)
  const file = resolve(activeUiProfile(process.cwd()).profile, 'local/dsh-ui-tweaks/lib/client.js')
  const deployedCss = clientCss(readFileSync(file, 'utf8'))
  assertWideHeader(deployedCss)
  assertNarrowHeader(deployedCss)
  // Whole-client deployment identity belongs to ui-tweaks-motion-guard's
  // accepted SHA/link/bundle check, not equality with undeployed candidate SOURCE.
})
test('missing wide or narrow header rules and hidden actions remain negative controls', () => {
  for (const [rule, verify] of [
    ['headerActions{height:auto!important;min-height:28px;min-width:0;flex-wrap:wrap', assertWideHeader],
    ['.ZKlsPq_trigger{flex-shrink:0;white-space:nowrap}', assertWideHeader],
    ['grid-template-columns:minmax(0,max-content) minmax(0,1fr) auto!important', assertWideHeader],
    ['headerActions{grid-row:2!important;grid-column:1 / -1!important}', assertNarrowHeader],
    ['[data-dcu-inline-tabs]{grid-row:3!important;grid-column:1 / -1!important}', assertNarrowHeader],
  ] as const) {
    const broken = css.replace(rule, '/* required header rule removed */')
    assert.notEqual(broken, css, `Negative control did not remove ${rule}`)
    assert.throws(() => verify(broken))
  }
  assert.throws(() => assertNarrowHeader(css + '.ZKlsPq_trigger{display:none}'))
  assert.throws(() => clientCss('/* CSS bundle removed */'), /CSS bundle is missing/)
})
