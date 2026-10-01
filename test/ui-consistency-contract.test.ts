import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import test from 'node:test'

type Input = Record<string, any>
// Source scripts are deliberately not copied into dist or loaded from Data.
const moduleUrl = new URL('../../scripts/lib/ui-consistency-contract.mjs', import.meta.url)
const load = () => import(moduleUrl.href) as Promise<any>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const theme = ':root{--dsh-font-ui:"Segoe UI",sans-serif;--dsh-font-size-control:12px}'
const client = '.owned{font-family:var(--dsh-font-ui,"Segoe UI",sans-serif)}.owned button{font-size:var(--dsh-font-size-control,12px)}'
const make = (): Input => ({
  catalog: { schema: 1,
    sourceGroups: [{ id: 'test-owned', ownedRoot: 'assets', sourceFiles: ['assets/theme.css', 'assets/view.css'], ownership: 'repository' }],
    tokenDefinitions: [{ token: '--dsh-font-ui', source: 'assets/theme.css' }, { token: '--dsh-font-size-control', source: 'assets/theme.css' }],
    surfaces: [{ id: 'view', groupId: 'test-owned', kind: 'settings', entry: 'fixture-only', state: 'verified', rootSelectors: ['.owned'], sourceFiles: ['assets/theme.css', 'assets/view.css'], roles: [{ id: 'family', selector: '.owned', property: 'font-family', token: '--dsh-font-ui' }, { id: 'control', selector: '.owned button', property: 'font-size', token: '--dsh-font-size-control' }] }],
    exceptions: [],
  },
  sources: [{ path: 'assets/theme.css', content: theme }, { path: 'assets/view.css', content: client }],
  discoveredUiSources: ['assets/theme.css', 'assets/view.css'],
})
const codes = (result: any) => result.findings.map((finding: any) => finding.code)
const observation = (input: Input): Input => {
  input.evidence = { schema: 1, kind: 'real-profile-ui', capturedAt: '2026-10-01T00:00:00Z', surfaces: [{ id: 'view', state: 'captured', real: true, isTrusted: true, sourceHashes: Object.fromEntries(input.sources.map((source: any) => [source.path, hash(source.content)])), screenshot: { path: 'fixture.png', sha256: 'a'.repeat(64) }, roles: [{ id: 'family', computedValue: '"Segoe UI", sans-serif', expectedValue: '"Segoe UI", sans-serif', fontFamily: '"Segoe UI", sans-serif', platformFonts: [{ familyName: 'Segoe UI', glyphCount: 8 }] }, { id: 'control', computedValue: '12px', expectedValue: '12px' }], checks: { focus: true, responsive: true, paint: true } }] }
  return input
}

test('catalog verified labels and source-only success never become real UI acceptance', async () => {
  const { evaluateUiConsistency } = await load()
  const result = evaluateUiConsistency(make())
  assert.equal(result.status, 'blocked')
  assert.equal(result.acceptance, 'not-performed')
  assert.ok(codes(result).includes('UNVERIFIED_SURFACE'))
  assert.equal(result.coverage[0].accepted, false)
})

test('new owned UI files omitted from the catalog fail regardless of gitignore', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); input.discoveredUiSources.push('assets/new-settings.html')
  assert.ok(codes(evaluateUiConsistency(input)).includes('UNREGISTERED_UI_SOURCE'))
})

test('root important font override and semantic size drift are not approved as exceptions', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); input.sources[1].content = '.owned{font-family:Arial!important}.owned button{font-size:16px}'
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'fail')
  assert.ok(codes(result).includes('ROOT_FAMILY_OVERRIDE'))
  assert.ok(codes(result).includes('ROLE_VALUE_DRIFT'))
})

test('fallbacks inside declared var and comments/artwork are not hardcoded style violations', async () => {
  const { evaluateUiConsistency, inspectUiSource } = await load()
  const input = make(); input.sources[1].content += '/* font-family:Arial;color:#fff */'
  assert.ok(!codes(evaluateUiConsistency(input)).includes('ROLE_VALUE_DRIFT'))
  const inspected = inspectUiSource('plugins/example.js', '// "font-family:Arial;color:#fff"\nconst art="data:image/png;base64,ABCD"; const css=`.owned{font-family:var(--dsh-font-ui,"Arial");color:var(--dsh-text-primary,#fff)}`')
  assert.equal(inspected.rules.length, 2)
})

test('declared missing shared token or missing consumer remains a diagnosed gap', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); input.catalog.tokenDefinitions[0].token = '--missing'
  input.catalog.surfaces[0].roles[0].selector = '.missing'
  const result = evaluateUiConsistency(input)
  assert.ok(codes(result).includes('TOKEN_DEFINITION_MISSING'))
  assert.ok(codes(result).includes('ROLE_CONSUMER_MISSING'))
})

test('a missing public token for a different size role is blocked, not forced to 24px', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); delete input.catalog.surfaces[0].roles[1].token
  const result = evaluateUiConsistency(input)
  assert.ok(codes(result).includes('ROLE_TOKEN_MISSING'))
  assert.ok(!codes(result).includes('ROLE_VALUE_DRIFT'))
})

test('fake evidence flags cannot replace a checked screenshot or actual font samples', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(make()); input.evidence.surfaces[0].roles[0].platformFonts = []
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'blocked')
  assert.ok(codes(result).includes('MISSING_SCREENSHOT'))
  assert.ok(codes(result).includes('MISSING_FONT_SAMPLE'))
  assert.equal(result.acceptance, 'not-performed')
})

test('current screenshot does not hide controlled-source drift', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(make()); input.evidence.surfaces[0].sourceHashes['assets/theme.css'] = 'b'.repeat(64)
  assert.ok(codes(evaluateUiConsistency(input)).includes('SOURCE_DRIFT'))
})

test('actual computed role mismatch and untrusted navigation block the candidate', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(make()); input.evidence.surfaces[0].roles[1].computedValue = '16px'
  assert.ok(codes(evaluateUiConsistency(input)).includes('STYLE_TOKEN_MISMATCH'))
  input.evidence.surfaces[0].isTrusted = false
  assert.ok(codes(evaluateUiConsistency(input)).includes('UNVERIFIED_SURFACE'))
})

test('exact code role exception is permitted but group wildcards and path traversal fail', async () => {
  const { evaluateUiConsistency, uiSourcePath } = await load()
  const input = make(); input.sources[1].content = '.owned{font-family:ui-monospace!important}.owned button{font-size:var(--dsh-font-size-control,12px)}'
  input.catalog.exceptions.push({ scope: { source: 'assets/view.css', selector: '.owned', property: 'font-family', value: 'ui-monospace!important', rule: 'ROOT_FAMILY_OVERRIDE' }, reason: 'Fixture narrowly represents a source editor, not a group-wide exemption' })
  assert.ok(!codes(evaluateUiConsistency(input)).includes('ROOT_FAMILY_OVERRIDE'))
  input.catalog.exceptions[0].scope.source = 'assets/*'
  assert.ok(codes(evaluateUiConsistency(input)).includes('EXCEPTION_TOO_BROAD'))
  for (const path of ['../outside.css', 'assets/../outside.css', 'C:/outside.css', 'assets\\view.css']) assert.throws(() => uiSourcePath(path))
})

test('embedded CSS concatenated fragments are inspected without executing the plugin', async () => {
  const { inspectUiSource } = await load()
  const result = inspectUiSource('plugins/client.js', "const styles=['.owned{', 'font-family:var(--dsh-font-ui);', 'font-size:14px}'].join(''); throw Error('must never execute')")
  assert.equal(result.rules.length, 2)
  assert.equal(result.rules[0].selector, '.owned')
})

test('dynamic stylesheet extraction is explicitly blocked rather than pretending complete', async () => {
  const { inspectUiSource } = await load()
  assert.ok(inspectUiSource('plugins/client.js', 'const css=`.owned{color:${themeColor};font-size:14px}`').gaps.some((gap: any) => gap.code === 'DYNAMIC_STYLE_REVIEW'))
})

test('font shorthand and direct cssText retain source ownership diagnostics', async () => {
  const { evaluateUiConsistency, inspectUiSource } = await load()
  const input = make(); input.sources[1].content = '.owned{font:14px/1.5 Arial!important}.owned button{font-size:var(--dsh-font-size-control)}'
  assert.ok(codes(evaluateUiConsistency(input)).includes('ROOT_FAMILY_OVERRIDE'))
  const inline = inspectUiSource('plugins/client.js', "bar.style.cssText='padding:8px;font:12px/1.4 system-ui'")
  assert.equal(inline.rules.find((rule: any) => rule.property === 'font')?.selector, ':inline-style')
})

test('invalid boundaries and role metadata fail without touching runtime trees', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); input.catalog.sourceGroups[0].ownedRoot = 'Data'
  assert.ok(codes(evaluateUiConsistency(input)).includes('PATH_INVALID'))
  const wrongRole = make(); wrongRole.catalog.surfaces[0].roles.push({ id: 'family', property: 'font-family', token: '--dsh-font-ui' })
  assert.ok(codes(evaluateUiConsistency(wrongRole)).includes('ROLE_INVALID'))
  const malformed = make(); malformed.catalog.tokenDefinitions = null
  assert.ok(codes(evaluateUiConsistency(malformed)).includes('TOKEN_DEFINITION_INVALID'))
})

test('missing controlled source and empty font usage cannot be hidden by evidence verdict', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(make()); input.evidence.status = 'pass'; input.evidence.surfaces[0].state = 'accepted'
  input.sources.pop()
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'fail')
  assert.ok(codes(result).includes('SOURCE_MISSING'))
  assert.ok(codes(result).includes('ACCEPTANCE_NOT_VALIDATED'))
  assert.equal(result.acceptance, 'not-performed')
})

test('third-party code is inventoried but is not silently rewritten or treated as owned style', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); input.catalog.sourceGroups[0].ownership = 'third-party'
  input.sources[1].content = '.owned{font-family:Arial!important}.owned button{font-size:16px}'
  const result = evaluateUiConsistency(input)
  assert.ok(!codes(result).includes('ROOT_FAMILY_OVERRIDE'))
  assert.ok(!codes(result).includes('ROLE_VALUE_DRIFT'))
  assert.ok(codes(result).includes('UNVERIFIED_SURFACE'))
})

test('unknown actual record, absent live token value and missing interaction check remain blocked', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(make()); delete input.evidence.surfaces[0].roles[0].expectedValue
  input.evidence.surfaces[0].checks.focus = false
  const result = evaluateUiConsistency(input)
  assert.ok(codes(result).includes('MISSING_STYLE_SAMPLE'))
  assert.ok(codes(result).includes('RUNTIME_CHECK_MISSING'))
  assert.equal(result.status, 'blocked')
})

const withFixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-consistency-'))
  try { await run(root) } finally {
    assert.ok(relative(tmpdir(), root).startsWith('dsh-ui-consistency-'))
    await rm(root, { recursive: true, force: true })
  }
}
const put = async (root: string, path: string, value: string) => {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, value, 'utf8')
}
const putOwned = async (root: string) => {
  await put(root, 'assets/theme.css', theme)
  await put(root, 'assets/view.css', client)
}
const tree = async (root: string, path = ''): Promise<any[]> => {
  const entries = await readdir(join(root, path), { withFileTypes: true })
  const rows: any[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path ? path + '/' + entry.name : entry.name
    const stat = await lstat(join(root, child))
    if (entry.isDirectory()) { rows.push({ path: child, type: 'directory' }); rows.push(...await tree(root, child)) }
    else rows.push({ path: child, size: stat.size, mtimeMs: stat.mtimeMs, hash: entry.isSymbolicLink() ? 'link' : hash(await readFile(join(root, child), 'utf8')) })
  }
  return rows
}
const shared = (): Input => {
  const input = make()
  input.catalog.sourceGroups.push({ id: 'plugin', ownedRoot: 'plugins/example', ownership: 'repository', sourceFiles: ['plugins/example/client.js'] })
  input.sources.push({ path: 'plugins/example/client.js', content: 'const css=`.owned{font-family:var(--dsh-font-ui)}`' })
  input.discoveredUiSources.push('plugins/example/client.js')
  input.catalog.surfaces[0].groupId = 'plugin'
  input.catalog.surfaces[0].sourceFiles = ['plugins/example/client.js']
  input.catalog.surfaces[0].roles = [input.catalog.surfaces[0].roles[0]]
  input.catalog.sharedSourceFiles = ['assets/theme.css']
  return input
}

test('global shared sources invalidate plugin captures without inventing cross-group ownership', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(shared())
  assert.ok(!codes(evaluateUiConsistency(input)).includes('SURFACE_SOURCE_OUTSIDE_GROUP'))
  assert.deepEqual(evaluateUiConsistency(input).coverage[0].sourceFiles, ['plugins/example/client.js', 'assets/theme.css'])
  input.sources[0].content += '\n:root{--new-global-token:1px}'
  assert.ok(codes(evaluateUiConsistency(input)).includes('SOURCE_DRIFT'))
})

test('missing shared source hash is a failure, not an unverified-but-successful plugin page', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(shared()); delete input.evidence.surfaces[0].sourceHashes['assets/theme.css']
  assert.equal(evaluateUiConsistency(input).status, 'fail')
  assert.ok(codes(evaluateUiConsistency(input)).includes('SOURCE_DRIFT'))
})

test('shared allowlist must use registered sources and cannot permit arbitrary cross-group files', async () => {
  const { evaluateUiConsistency } = await load()
  const input = shared(); input.catalog.sharedSourceFiles.push('assets/unregistered.css')
  assert.ok(codes(evaluateUiConsistency(input)).includes('SHARED_SOURCE_NOT_REGISTERED'))
  const cross = shared(); cross.catalog.surfaces[0].sourceFiles.push('assets/view.css')
  assert.ok(codes(evaluateUiConsistency(cross)).includes('SURFACE_SOURCE_OUTSIDE_GROUP'))
  const allowed = shared(); allowed.catalog.surfaces[0].sourceFiles.push('assets/theme.css')
  assert.ok(!codes(evaluateUiConsistency(allowed)).includes('SURFACE_SOURCE_OUTSIDE_GROUP'))
})

test('filesystem adapter detects a real added UI file even when gitignore excludes it', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    await put(root, '.gitignore', 'assets/new-settings.html\n')
    await put(root, 'assets/new-settings.html', '<html><body>Unregistered settings</body></html>')
    const result = await auditUiConsistency({ repositoryRoot: root, catalog: make().catalog })
    assert.equal(result.status, 'fail')
    assert.ok(result.findings.some((finding: any) => finding.code === 'UNREGISTERED_UI_SOURCE' && finding.path === 'assets/new-settings.html'))
  })
})

test('filesystem adapter rejects real directory links and does not read their target', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    await put(root, 'unowned/hidden.html', '<html><body>Must not enter</body></html>')
    await symlink(join(root, 'unowned'), join(root, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await auditUiConsistency({ repositoryRoot: root, catalog: make().catalog })
    assert.ok(codes(result).includes('LINK_NOT_SCANNED'))
    assert.ok(!Object.keys(result.sourceHashes).some(path => path.includes('hidden.html')))
  })
})

test('filesystem adapter is read-only: all file bytes and mtimes unchanged and no Data directory created', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    const before = await tree(root)
    const result = await auditUiConsistency({ repositoryRoot: root, catalog: make().catalog })
    assert.equal(result.status, 'blocked')
    assert.deepEqual(await tree(root), before)
    assert.ok(!(await readdir(root)).includes('Data'))
  })
})

test('filesystem adapter enforces tightened byte and file budgets without following unbounded trees', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    const before = await tree(root)
    for (const limits of [{ maxFiles: 1 }, { maxBytesPerFile: 8 }]) {
      const result = await auditUiConsistency({ repositoryRoot: root, catalog: make().catalog, limits })
      assert.equal(result.status, 'fail')
      assert.ok(result.findings.some((finding: any) => finding.code === 'SOURCE_READ_BLOCKED' && finding.message.includes('budget')))
    }
    await assert.rejects(auditUiConsistency({ repositoryRoot: root, catalog: make().catalog, limits: { maxDepth: 10000 } }), /tightened/)
    assert.deepEqual(await tree(root), before)
  })
})

const runtimeFixture = async (root: string, schema: 1 | 2 | undefined = 1) => {
  const version = '0.2.0-rc.2', slot = 'Data/Runtime/Harness/slots/0.2.0-rc.2-fingerprint', generation = 'fixture-home'
  await mkdir(join(root, slot), { recursive: true })
  const pointer = { schema: 1, current: { relativePath: slot.slice('Data/Runtime/'.length), version } }
  await put(root, 'Data/Runtime/Harness/current.json', JSON.stringify(pointer))
  const binding = schema === undefined ? undefined : { schema, runtimeVersion: version, generation, ...(schema === 2 ? { runtimeRelativePath: slot } : {}) }
  if (binding) await put(root, `Data/Updates/Harness/homes/${version}.json`, JSON.stringify(binding))
  const runtime = schema === 1 ? `Data/DSH-generations/${generation}/runtime/dsh-runtime` : slot
  const profile = schema === undefined ? 'Data/DSH/profiles/web' : `Data/DSH-generations/${generation}/home/profiles/web`
  await put(root, profile + '/package.json', '{"name":"fixture-profile"}')
  await put(root, runtime + '/node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  await put(root, runtime + '/node_modules/@deepseek-ai/dsh/lib/bin.js', '// fixture: never execute')
  await put(root, runtime + '/node_modules/@deepseek-ai/dsh-client-ui-settings/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-settings', version }))
  await put(root, runtime + '/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js', 'const css=`.owned{font-family:var(--dsh-font-ui)}`;throw Error("Do not execute fixture UI")')
  return { version, pointer, binding, runtime, profile }
}

test('runtime home selection mirrors schema1 generation and schema2 exact current slot without fallback', async () => {
  const { runtimeBindingPaths } = await load()
  const pointer = { schema: 1, current: { version: '0.2.0-rc.2', relativePath: 'Harness/slots/0.2.0-rc.2-fingerprint' } }
  const schema1 = runtimeBindingPaths(pointer, { schema: 1, runtimeVersion: '0.2.0-rc.2', generation: 'fixture-home' })
  assert.equal(schema1.runtimeRelativePath, 'Data/DSH-generations/fixture-home/runtime/dsh-runtime')
  const schema2 = runtimeBindingPaths(pointer, { schema: 2, runtimeVersion: '0.2.0-rc.2', generation: 'fixture-home', runtimeRelativePath: 'Data/Runtime/Harness/slots/0.2.0-rc.2-fingerprint' })
  assert.equal(schema2.runtimeRelativePath, 'Data/Runtime/Harness/slots/0.2.0-rc.2-fingerprint')
  assert.equal(runtimeBindingPaths(pointer, undefined).profileRelativePath, 'Data/DSH/profiles/web')
  assert.throws(() => runtimeBindingPaths({ ...pointer, pendingTransactionId: 'pending' }, undefined), /Uncommitted/)
  assert.throws(() => runtimeBindingPaths(pointer, { schema: 1, runtimeVersion: 'wrong', generation: 'fixture-home' }), /fallback forbidden/)
  assert.throws(() => runtimeBindingPaths(pointer, { schema: 2, runtimeVersion: '0.2.0-rc.2', generation: 'fixture-home', runtimeRelativePath: 'Data/Runtime/Harness/slots/other-slot' }), /fallback forbidden/)
})

test('real filesystem runtime resolver binds both supported layouts and verifies main package identity', async () => {
  const { resolveUiRuntimeAnchor } = await load()
  for (const schema of [1, 2] as const) await withFixture(async root => {
    const fixture = await runtimeFixture(root, schema)
    const before = await tree(root)
    const anchor = await resolveUiRuntimeAnchor(root)
    assert.equal(anchor.runtimeRelativePath, fixture.runtime)
    assert.equal(anchor.profileRelativePath, fixture.profile)
    assert.deepEqual(await tree(root), before)
    await put(root, fixture.runtime + '/node_modules/@deepseek-ai/dsh/package.json', '{"name":"not-dsh","version":"0.2.0-rc.2"}')
    await assert.rejects(resolveUiRuntimeAnchor(root), /identity\/version/)
  })
})

test('real wrong home binding and pending transaction are rejected instead of reading an old runtime', async () => {
  const { resolveUiRuntimeAnchor } = await load()
  await withFixture(async root => {
    const fixture = await runtimeFixture(root, 2)
    await put(root, `Data/Updates/Harness/homes/${fixture.version}.json`, JSON.stringify({ ...fixture.binding, runtimeRelativePath: 'Data/Runtime/Harness/slots/wrong' }))
    await assert.rejects(resolveUiRuntimeAnchor(root))
    await put(root, `Data/Updates/Harness/homes/${fixture.version}.json`, JSON.stringify(fixture.binding))
    await put(root, 'Data/Runtime/Harness/current.json', JSON.stringify({ ...fixture.pointer, pendingTransactionId: 'pending' }))
    await assert.rejects(resolveUiRuntimeAnchor(root), /Uncommitted/)
  })
})

test('@runtime adapter reads only the explicit named third-party package and never executes it', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    const fixture = await runtimeFixture(root, 1)
    const catalog = make().catalog
    catalog.sourceGroups.push({ id: 'official-settings', ownership: 'third-party', ownedRoot: '@runtime/node_modules/@deepseek-ai/dsh-client-ui-settings', sourceFiles: ['@runtime/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js'] })
    const before = await tree(root)
    const result = await auditUiConsistency({ repositoryRoot: root, catalog })
    assert.equal(result.runtimeBinding.runtimeRelativePath, fixture.runtime)
    assert.ok(result.sourceHashes['@runtime/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js'])
    assert.ok(!Object.keys(result.sourceHashes).some(path => path.includes('/dsh/lib/bin.js')))
    assert.deepEqual(await tree(root), before)
  })
})

test('missing binding selects only the verified current slot and still rejects a wrong main version', async () => {
  const { resolveUiRuntimeAnchor } = await load()
  await withFixture(async root => {
    const fixture = await runtimeFixture(root, 2)
    await rm(join(root, `Data/Updates/Harness/homes/${fixture.version}.json`))
    await put(root, 'Data/DSH/profiles/web/package.json', '{"name":"fixture-legacy-profile"}')
    const anchor = await resolveUiRuntimeAnchor(root)
    assert.equal(anchor.runtimeRelativePath, fixture.runtime)
    assert.equal(anchor.profileRelativePath, 'Data/DSH/profiles/web')
    await put(root, fixture.runtime + '/node_modules/@deepseek-ai/dsh/package.json', '{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}')
    await assert.rejects(resolveUiRuntimeAnchor(root), /identity\/version/)
  })
})

test('guest website content may omit DSH typography only under a justified exact guest boundary', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); Object.assign(input.catalog.surfaces[0], { kind: 'external-content', boundary: 'guest-content', reason: 'Fixture represents only guest website content, excluding its DSH toolbar', roles: [] })
  const result = evaluateUiConsistency(input)
  assert.ok(!codes(result).includes('ROLE_COVERAGE_MISSING'))
  assert.equal(result.coverage[0].state, 'excluded-guest-content')
  delete input.catalog.surfaces[0].reason
  assert.ok(codes(evaluateUiConsistency(input)).includes('GUEST_BOUNDARY_UNJUSTIFIED'))
  assert.equal(evaluateUiConsistency(input).status, 'fail')
})

test('declaration files mentioning client slots are not executable UI pages', async () => {
  const { isUiSource } = await load()
  for (const path of ['plugins/lib/types/client.d.ts', 'plugins/lib/client.d.cts', 'plugins/lib/client.d.mts']) assert.equal(isUiSource(path, 'declare const client: { slots: { register(): void } };'), false)
  assert.equal(isUiSource('plugins/lib/client.js', 'ctx.slots.register({ name:"main" })'), true)
})

test('third-party dynamic CSS does not become an owned style violation but still needs real UI coverage', async () => {
  const { evaluateUiConsistency } = await load()
  const input = make(); input.catalog.sourceGroups[0].ownership = 'third-party'
  input.sources[1].content = 'const css=`.owned{color:${themeColor};font-size:14px}`'
  const result = evaluateUiConsistency(input)
  assert.ok(!codes(result).includes('DYNAMIC_STYLE_REVIEW'))
  assert.ok(codes(result).includes('UNVERIFIED_SURFACE'))
  assert.equal(result.status, 'blocked')
})

test('captured runtime and Profile metadata must match the actual selected combination', async () => {
  const { evaluateUiConsistency } = await load()
  const input = observation(make())
  input.runtimeBinding = { runtimeVersion: '0.2.0-rc.2', metadataHashes: { 'Data/Runtime/Harness/current.json': 'c'.repeat(64) } }
  input.evidence.profile = { runtimeVersion: '0.1.7-rc.2' }
  assert.ok(codes(evaluateUiConsistency(input)).includes('RUNTIME_BINDING_DRIFT'))
  input.evidence.profile.runtimeVersion = '0.2.0-rc.2'
  assert.ok(codes(evaluateUiConsistency(input)).includes('RUNTIME_METADATA_EVIDENCE_MISSING'))
  input.evidence.profile.metadataHashes = { 'Data/Runtime/Harness/current.json': 'b'.repeat(64) }
  assert.ok(codes(evaluateUiConsistency(input)).includes('RUNTIME_METADATA_DRIFT'))
  input.evidence.profile.metadataHashes['Data/Runtime/Harness/current.json'] = 'c'.repeat(64)
  assert.ok(!codes(evaluateUiConsistency(input)).includes('RUNTIME_METADATA_DRIFT'))
  assert.equal(evaluateUiConsistency(input).acceptance, 'not-performed')
})

test('exact third-party package hardlinks are read-only and an inventory identity mismatch fails', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    const fixture = await runtimeFixture(root, 1)
    const packageRoot = fixture.profile + '/node_modules/@michengai/fixture-client'
    const packageJson = packageRoot + '/package.json', clientPath = packageRoot + '/lib/client.js'
    await put(root, packageJson, '{"name":"@michengai/fixture-client","version":"1.2.3"}')
    await put(root, clientPath, 'const css=`.peer{font-size:14px}`;throw Error("do not execute")')
    await mkdir(join(root, 'hardlink-fixture'), { recursive: true })
    await link(join(root, packageJson), join(root, 'hardlink-fixture', 'package-copy.json'))
    await link(join(root, clientPath), join(root, 'hardlink-fixture', 'client-copy.js'))
    assert.ok((await lstat(join(root, clientPath))).nlink > 1)
    assert.ok((await lstat(join(root, packageJson))).nlink > 1)
    const catalog = make().catalog
    catalog.sourceGroups.push({ id: 'peer', ownership: 'third-party', inventoryVersion: '1.2.3', ownedRoot: '@active/node_modules/@michengai/fixture-client', sourceFiles: ['@active/node_modules/@michengai/fixture-client/lib/client.js'] })
    const before = await tree(root)
    const result = await auditUiConsistency({ repositoryRoot: root, catalog })
    assert.ok(result.sourceHashes['@active/node_modules/@michengai/fixture-client/lib/client.js'])
    assert.ok(!codes(result).includes('SOURCE_READ_BLOCKED'))
    assert.deepEqual(await tree(root), before)
    catalog.sourceGroups.at(-1).inventoryVersion = '2.0.0'
    const wrongIdentity = await auditUiConsistency({ repositoryRoot: root, catalog })
    assert.ok(codes(wrongIdentity).includes('SOURCE_IDENTITY_DRIFT'))
    assert.equal(wrongIdentity.status, 'fail')
    assert.deepEqual(await tree(root), before)
  })
})

test('allowing read-only package hardlinks does not relax owned source hardlink rejection', async () => {
  const { auditUiConsistency } = await load()
  await withFixture(async root => {
    await putOwned(root)
    await mkdir(join(root, 'hardlink-fixture'), { recursive: true })
    await link(join(root, 'assets/view.css'), join(root, 'hardlink-fixture', 'owned-copy.css'))
    const before = await tree(root)
    const result = await auditUiConsistency({ repositoryRoot: root, catalog: make().catalog })
    assert.ok(codes(result).includes('SOURCE_READ_BLOCKED'))
    assert.equal(result.status, 'fail')
    assert.deepEqual(await tree(root), before)
  })
})

// Deliberately synthetic "all green" metadata is an old-branch counterexample,
// not real capture evidence. Even an injected screenshot flag must not turn
// this fixture into loaded-source or production acceptance.
const diagnosticOnly = (): Input => {
  const input = observation(make())
  input.evidence.profile = { runtimeVersion: '0.2.0-rc.2', fixtureOnly: true }
  input.artifactChecks = { view: { screenshot: true } }
  return input
}

test('complete diagnostic metadata without runtimeSourceEvidence remains source-unproven', async () => {
  const { evaluateUiConsistency } = await load()
  const result = evaluateUiConsistency(diagnosticOnly())
  assert.equal(result.status, 'blocked')
  assert.ok(codes(result).includes('SOURCE_BINDING_UNPROVEN'))
  assert.equal(result.coverage[0].state, 'captured-source-unproven')
  assert.equal(result.coverage[0].sourceBindingVerified, false)
  assert.equal(result.acceptance, 'not-performed')
  assert.equal(result.runtimeSourceVerification, 'unsupported-v1')
})

test('snapshot-only source evidence cannot become loaded-byte evidence', async () => {
  const { evaluateUiConsistency } = await load()
  const input = diagnosticOnly()
  input.evidence.surfaces[0].runtimeSourceEvidence = { schema: 1, scope: 'isolated-candidate', bindings: input.sources.map((source: any) => ({ input: { id: source.path, sha256: hash(source.content) }, kind: 'source-snapshot-only-not-a-loaded-byte-claim' })) }
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'blocked')
  assert.ok(codes(result).includes('SOURCE_BINDING_PROOF_UNSUPPORTED'))
  assert.equal(result.coverage[0].sourceBindingVerified, false)
})

test('equal-copy labels and verified artifact flags without a Loader trace never pass', async () => {
  const { evaluateUiConsistency } = await load()
  const input = diagnosticOnly()
  input.evidence.surfaces[0].runtimeSourceEvidence = { schema: 1, verified: true, bindings: input.sources.map((source: any) => ({ input: { id: source.path, sha256: hash(source.content) }, output: { sha256: hash(source.content) }, binding: 'exact-actual-source-bytes', verified: true })) }
  input.artifactChecks.view.runtimeSourceEvidence = { verified: true }
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'blocked')
  assert.ok(codes(result).includes('SOURCE_BINDING_UNPROVEN'))
  assert.ok(codes(result).includes('SOURCE_BINDING_PROOF_UNSUPPORTED'))
})

test('candidate bytes different from active bytes cannot be promoted to production by JSON scope', async () => {
  const { evaluateUiConsistency } = await load()
  const input = diagnosticOnly()
  input.evidence.surfaces[0].runtimeSourceEvidence = { schema: 1, scope: 'active-production', verified: true, bindings: [{ input: { id: 'assets/view.css', sha256: hash(client) }, activeSha256: hash('old active bytes'), output: { sha256: hash(client) }, kind: 'runtime-bytes' }] }
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'blocked')
  assert.equal(result.coverage[0].runtimeScope, 'isolated-candidate')
  assert.equal(result.coverage[0].productionVerified, false)
  assert.equal(result.coverage[0].accepted, false)
})

test('generated output without a supported generation receipt and Loader trace remains blocked', async () => {
  const { evaluateUiConsistency } = await load()
  const input = diagnosticOnly()
  input.evidence.surfaces[0].runtimeSourceEvidence = { schema: 1, scope: 'isolated-candidate', bindings: [{ input: { id: 'assets/view.css', sha256: hash(client) }, output: { path: 'unverified-output.js', sha256: hash('compiled output') }, kind: 'generated', verified: true }] }
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'blocked')
  assert.ok(codes(result).includes('SOURCE_BINDING_PROOF_UNSUPPORTED'))
  assert.equal(result.coverage[0].sourceBindingVerified, false)
})

test('shared TS snapshots leave every consumer source-unproven despite current hashes and copied outputs', async () => {
  const { evaluateUiConsistency } = await load()
  const input = diagnosticOnly(), template = 'export const markup = "maintained template input"'
  input.catalog.sourceGroups.push({ id: 'template-source', ownedRoot: 'src', ownership: 'repository', sourceFiles: ['src/template.ts'] })
  input.catalog.sharedSourceFiles = ['src/template.ts']
  input.sources.push({ path: 'src/template.ts', content: template })
  input.catalog.surfaces.push({ ...input.catalog.surfaces[0], id: 'second-view' })
  for (const surface of input.evidence.surfaces) surface.sourceHashes['src/template.ts'] = hash(template)
  input.evidence.surfaces.push({ ...input.evidence.surfaces[0], id: 'second-view' })
  input.artifactChecks['second-view'] = { screenshot: true }
  input.evidence.runtimeSourceEvidence = { schema: 1, bindings: [{ input: { id: 'src/template.ts', sha256: hash(template) }, output: { sha256: hash(template) }, binding: 'exact-copy', verified: true }] }
  const result = evaluateUiConsistency(input)
  assert.equal(result.status, 'blocked')
  assert.equal(result.findings.filter((finding: any) => finding.code === 'SOURCE_BINDING_UNPROVEN').length, 2)
  assert.ok(result.coverage.every((row: any) => row.state === 'captured-source-unproven' && row.sourceBindingVerified === false))
  assert.ok(!codes(result).includes('SOURCE_DRIFT'))
})
