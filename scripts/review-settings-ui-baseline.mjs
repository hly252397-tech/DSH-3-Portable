// Bounded review report only. Does NOT register/alter the acceptance baseline.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { verifyBaseline, digest } from './ui-baseline.mjs'
const read = path => readFileSync(path, 'utf8')
const json = path => JSON.parse(read(path))
const base = 'customizations/audit-fixes/20260927/settings-entry'
const paths = [
  'assets/shell.html', 'src/dsh-view-preload.cts', 'customizations/custom-spaces/lib/client.js',
  'Data/DSH-generations/v4-rc2b/home/profiles/web/local/dsh-custom-spaces/lib/client.js',
]
assert.deepEqual(verifyBaseline(process.cwd()).sort(), paths.map(p => 'UI drift: ' + p).sort(), 'Unreviewed drift or a non-content problem; do not record')
const profile = json(base + '/profile-validation/results.json')
assert.equal(profile.status, 'pass'); assert.equal(profile.results.length, 12)
assert.deepEqual(profile.errors, [])
assert.ok(profile.clickTrace.length >= 5 && profile.clickTrace.every(c => c.events.length > 0))
const indicator = json(base + '/update-indicator/results.json')
assert.equal(indicator.status, 'pass'); assert.equal(indicator.results.length, 209)
// Reuse the previously captured REAL service probe only if both current copies
// are byte-identical to the source accepted in that same documented test run.
const expectedSpacesHash = '45e0d73c93b07de5ed48aaed95c8e2ae6ab03db267e56cbb158635fc99929aae'
for (const path of paths.slice(2)) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expectedSpacesHash)
const priorProbe = json('customizations/audit-fixes/20260927/spaces-service-merge/live-probe.json')
assert.equal(priorProbe.probeResponse.status, 200); assert.equal(priorProbe.probeResponse.running, true)
assert.equal(priorProbe.headings.length, 1); assert.equal(priorProbe.form, true)
assert.equal(priorProbe.nav.filter(n => n === '自定义空间').length, 1)
assert.equal(priorProbe.nav.includes('物料录入工作台'), false)
for (const width of [1360, 1000]) assert.ok(existsSync(`customizations/audit-fixes/20260927/spaces-service-merge/settings-${width}.png`))
const old = json('customizations/ui/baseline.json')
const results = paths.map(path => ({ name: path, pass: true, oldSha256: old.files.find(f => f.path === path).sha256,
  sha256: digest(read(path).replace(/\r\n/g, '\n')),
  evidence: path.includes('custom-spaces') ? 'previous real active Profile service probe; exact tested source hash retained; no claim of current startup acceptance' : 'current isolated real Profile/preload/main IPC and native renderer checks',
}))
const report = { status: 'pass', scope: 'reviewed-source-and-plugin-baseline-only; desktop activation remains pending',
  reviewedAt: new Date().toISOString(), baselineHistoryBefore: old.history, results,
  remaining: ['active old desktop settings.html ERR_FAILED seen during recheck', 'packaged candidate and user-approved restart acceptance not completed'],
}
writeFileSync(base + '/baseline-review.json', JSON.stringify(report, null, 2) + '\n')
console.log('PASS reviewed four intended deltas; unchanged protected files retained; no baseline written')
