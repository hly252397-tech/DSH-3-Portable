import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const { WORKBENCH_GEOMETRY_FILES, findWorkbenchGeometryViolations, findWorkbenchProbeViolations } =
  await import(pathToFileURL(resolve('scripts/workbench-geometry-guard.mjs')).href)

const paths = WORKBENCH_GEOMETRY_FILES as string[]
const sources = Object.fromEntries(paths.map((path) => [path, existsSync(resolve(path)) ? readFileSync(resolve(path), 'utf8') : '']))

test('active workbench sources and bundles keep one width owner', (t) => {
  if (!existsSync(resolve('Data/DSH/profiles/web'))) return t.skip('fresh checkout has no active Web Profile')
  for (const path of paths) assert.ok(existsSync(resolve(path)), `missing active geometry source: ${path}`)
  assert.deepEqual(findWorkbenchGeometryViolations(sources), [])
})

test('the old empty-card cap and reservation override are rejected before rebuild', () => {
  const staleSource = { ...sources, [WORKBENCH_GEOMETRY_FILES[0]]: `${sources[WORKBENCH_GEOMETRY_FILES[0]]}\n.panel:has(.paneEmptyCards){max-width:560px!important}` }
  assert.match(findWorkbenchGeometryViolations(staleSource).join('\n'), /empty-card state caps the panel width/)
  const staleOverlay = { ...sources, 'customizations/ui-tweaks/lib/client.js': `${sources['customizations/ui-tweaks/lib/client.js']}\n'#root{margin-right:min(var(--dsh-sidebar-width),560px)}'` }
  assert.match(findWorkbenchGeometryViolations(staleOverlay).join('\n'), /overrides #root workbench reservation/)
})

test('real geometry check catches the 691/560 overlap and accepts aligned layout', () => {
  const aligned = {
    vw: 1325, compact: '0', sidebarVar: '685px', dragging: false,
    panelDiag: { panelRect: [640, 685], rootMarginRight: '685px', rootWidth: '640px' },
    boundaryDiag: { composer: { right: 623 } },
  }
  assert.deepEqual(findWorkbenchProbeViolations(aligned), [])
  const old = { ...aligned, sidebarVar: '691px', panelDiag: { panelRect: [640, 691], rootMarginRight: '560px', rootWidth: '771px' }, boundaryDiag: { composer: { right: 754 } } }
  assert.match(findWorkbenchProbeViolations(old).join('\n'), /691px != reservation 560px/)
  assert.match(findWorkbenchProbeViolations(old).join('\n'), /composer overlaps panel/)
})
