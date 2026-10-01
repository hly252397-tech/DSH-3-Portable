/** Detect a second width source before a local sidebar rebuild reaches the UI. */
export const WORKBENCH_GEOMETRY_FILES = [
  'Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/sidebar.module.css',
  'Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js',
  'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js',
  'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.js',
  'customizations/ui-tweaks/lib/client.js',
  'Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js',
  'assets/theme.css',
]

const betterBundle = WORKBENCH_GEOMETRY_FILES[1]
const expectedMargin = 'var(--dsh-sidebar-width,0px)'
const expectedWidth = 'calc(100%-var(--dsh-sidebar-width,0px))'
const compact = (value) => value.replace(/\s+/g, '')

export function findWorkbenchGeometryViolations(sources) {
  const failures = []
  for (const path of WORKBENCH_GEOMETRY_FILES) {
    const source = sources[path]
    if (typeof source !== 'string') {
      failures.push(`${path}: missing`)
      continue
    }
    // ui-tweaks contains historical examples in line comments, not live CSS.
    const active = source.replace(/^\s*\/\/[^\r\n]*/gm, '')
    if (/--(?:dss-panel-width|dsh-sidebar-width)\s*:/.test(active)) {
      failures.push(`${path}: CSS declares a second workbench width`)
    }
    const statePanel = /\.(?:nArs4W_)?panel:has\(\s*\.(?:nArs4W_)?(?:editorPlaceholder|paneEmptyCards)\s*\)\s*\{([^}]*)\}/g
    for (const rule of active.matchAll(statePanel)) {
      if (/(?:^|;)\s*(?:min-width|max-width|width)\s*:/.test(rule[1])) {
        failures.push(`${path}: empty-card state caps the panel width`)
      }
    }
    if (path !== betterBundle) {
      const rootRule = /#root\s*\{([^}]*)\}/g
      for (const rule of active.matchAll(rootRule)) {
        if (/(?:^|;)\s*(?:margin-right|width)\s*:/.test(rule[1])) {
          failures.push(`${path}: overrides #root workbench reservation`)
        }
      }
    }
  }

  const bundle = sources[betterBundle]
  if (typeof bundle === 'string') {
    const root = (bundle.match(/#root\s*\{([^}]*)\}/)?.[1] ?? '').replaceAll('\\n', '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const margin = root.match(/(?:^|;)\s*margin-right\s*:\s*([^;]+);/)?.[1]
    const width = root.match(/(?:^|;)\s*width\s*:\s*([^;]+);/)?.[1]
    if (compact(margin ?? '') !== expectedMargin || compact(width ?? '') !== expectedWidth) {
      failures.push(`${betterBundle}: #root must reserve exactly --dsh-sidebar-width`)
    }
  }
  return failures
}

export function findWorkbenchProbeViolations(sample) {
  if (sample?.dragging === true) return []
  const diag = sample?.panelDiag
  const width = Number.parseFloat(sample?.sidebarVar)
  const reserve = Number.parseFloat(diag?.rootMarginRight)
  const viewport = Number(sample?.vw)
  const rootWidth = Number.parseFloat(diag?.rootWidth)
  if (![width, reserve, viewport, rootWidth].every(Number.isFinite)) return ['probe: missing numeric geometry']
  const failures = []
  if (Math.abs(width - reserve) > 2) failures.push(`probe: panel variable ${width}px != reservation ${reserve}px`)
  if (width > 0 && sample?.compact !== '1') {
    const left = Number(diag?.panelRect?.[0])
    const panelWidth = Number(diag?.panelRect?.[1])
    const composerRight = Number(sample?.boundaryDiag?.composer?.right)
    if (![left, panelWidth, composerRight].every(Number.isFinite)) return [...failures, 'probe: missing panel or composer bounds']
    if (Math.abs(panelWidth - width) > 2) failures.push(`probe: rendered panel ${panelWidth}px != variable ${width}px`)
    if (Math.abs(rootWidth - left) > 2) failures.push(`probe: root right ${rootWidth}px != panel left ${left}px`)
    if (composerRight > left + 2) failures.push(`probe: composer overlaps panel by ${composerRight - left}px`)
  } else if (Math.abs(rootWidth - viewport) > 2 || Math.abs(width) > 2 || Math.abs(reserve) > 2) {
    failures.push('probe: compact or closed panel must release the conversation width')
  }
  return failures
}
