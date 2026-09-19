import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const api = await import(pathToFileURL(resolve('scripts/ui-baseline.mjs')).href)

test('accepted UI snapshots and source remain consistent with their change record', () => {
  assert.deepEqual(api.verifyBaseline(process.cwd(), { live: false }), [])
})

test('installed UI keeps local plugin links, enabled bundles and accepted content', t => {
  if (!existsSync(resolve('Data/DSH/profiles/web/package.json'))) return t.skip('实机 Profile 缺失，源码快照仍由上一项校验')
  assert.deepEqual(api.verifyBaseline(process.cwd()), [])
})

test('UI baseline rejects unrecorded changes, corrupt recovery snapshots and missing evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ui-baseline-'))
  const put = (p: string, s: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s) }
  try {
    for (const p of api.protectedPaths) put(p, 'accepted source\n')
    put('docs/change.md', 'reason, scope, verification')
    put('artifacts/qa.json', JSON.stringify({ status: 'pass', results: [{ name: 'real UI' }] }))
    assert.throws(() => api.recordBaseline(root, { note: 'docs/change.md', evidence: [] }), /evidence/)
    put('artifacts/fail.json', JSON.stringify({ status: 'fail', results: [] }))
    assert.throws(() => api.recordBaseline(root, { note: 'docs/change.md', evidence: ['artifacts/fail.json'] }), /not passing/)
    api.recordBaseline(root, { note: 'docs/change.md', evidence: ['artifacts/qa.json'] })
    assert.deepEqual(api.verifyBaseline(root, { live: false }), [])
    put('assets/theme.css', 'upstream replacement\n')
    assert.ok(api.verifyBaseline(root, { live: false }).includes('UI drift: assets/theme.css'))
    put('assets/theme.css', 'accepted source\r\n')
    assert.deepEqual(api.verifyBaseline(root, { live: false }), [], 'Git line-ending conversion is not semantic drift')
    const manifest = JSON.parse(readFileSync(join(root, 'customizations/ui/baseline.json'), 'utf8'))
    put(manifest.files[0].snapshot, 'damaged backup')
    assert.ok(api.verifyBaseline(root, { live: false }).some((s: string) => s.startsWith('Broken source snapshot:')))
    assert.throws(() => api.recordBaseline(root, { note: 'docs/../../outside.md', evidence: ['artifacts/qa.json'] }), /outside project/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
