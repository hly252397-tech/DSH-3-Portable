import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, extname } from 'node:path'
import { activeUiProfile } from './active-ui-profile.mjs'

// This is a maintenance audit, not a replacement for source preservation or
// user acceptance. In particular, catalog.state and evidence.status are never
// treated as proof that a screen was rendered or accepted.
export const UI_AUDIT_LIMITS = Object.freeze({ maxFiles: 2500, maxBytesPerFile: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxDepth: 16 })
const sha = value => createHash('sha256').update(value).digest('hex')
const hashLike = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const cleanSelector = value => String(value).trim().replace(/\s+/g, ' ')
const cleanValue = value => String(value).trim().replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ')
const uiExtensions = new Set(['.html', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cts', '.mts'])

export function uiSourcePath(value) {
  if (!text(value) || value.includes('\\') || value.includes('\0') || isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error('UI source paths must be portable repository-relative paths')
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..') || /[*?\[\]]/.test(value)) throw new Error('UI source path traversal, globs and empty segments are forbidden')
  return value
}

/** A deliberately limited, non-executing string lexer. It does not evaluate
 * templates or import a plugin. Dynamic CSS is reported as a coverage gap. */
function stringChunks(source) {
  const chunks = []
  let previousEnd = -1
  for (let i = 0; i < source.length;) {
    if (source.slice(i, i + 2) === '//') { i = source.indexOf('\n', i + 2); if (i < 0) break; continue }
    if (source.slice(i, i + 2) === '/*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue }
    const quote = source[i]
    if (!['"', "'", '`'].includes(quote)) { i++; continue }
    const start = i++
    let value = '', dynamic = false
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        const escaped = source[++i]
        value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped ?? ''
        i++
      } else {
        if (quote === '`' && source.slice(i, i + 2) === '${') dynamic = true
        value += source[i++]
      }
    }
    if (i < source.length) i++
    const between = previousEnd >= 0 ? source.slice(previousEnd, start) : ''
    if (chunks.length && /^\s*[+,]\s*$/.test(between)) {
      chunks.at(-1).content += value
      chunks.at(-1).dynamic ||= dynamic
    } else chunks.push({ content: value, offset: start + 1, dynamic, inline: /\.style\.cssText\s*=\s*$/.test(source.slice(Math.max(0, start - 100), start)) })
    previousEnd = i
  }
  return chunks
}

function cssBlocks(path, content) {
  const extension = extname(path).toLowerCase()
  if (['.css', '.scss', '.less'].includes(extension)) return [{ content, offset: 0, dynamic: false }]
  if (extension === '.html') {
    return [...content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => ({ content: match[1], offset: match.index + match[0].indexOf(match[1]), dynamic: false }))
  }
  return stringChunks(content).flatMap(chunk => {
    if (chunk.inline) return [{ ...chunk, content: `:inline-style{${chunk.content}}` }]
    return /[{}]/.test(chunk.content) && /(?:--[\w-]+|font(?:-family|-size)?|color|background|border|outline|padding|margin)\s*:/.test(chunk.content) ? [chunk] : []
  })
}

function declarationsIn(body) {
  const declarations = []
  let start = 0, depth = 0, quote = ''
  for (let i = 0; i <= body.length; i++) {
    const character = body[i]
    if (quote) { if (character === '\\') i++; else if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '(' || character === '[') depth++
    if (character === ')' || character === ']') depth--
    if ((character === ';' && depth === 0) || i === body.length) {
      const fragment = body.slice(start, i).trim(), colon = fragment.indexOf(':')
      if (colon > 0) {
        const property = fragment.slice(0, colon).trim()
        if (/^(?:--[\w-]+|[a-z-]+)$/i.test(property)) declarations.push({ property, value: fragment.slice(colon + 1).trim() })
      }
      start = i + 1
    }
  }
  return declarations
}

/** Inspect CSS rule bodies rather than matching colors in comments, code,
 * image data or prose. This parser intentionally cannot establish the browser
 * cascade: competing rules remain review findings, never a visual pass. */
export function inspectUiSource(path, content) {
  const rules = [], gaps = []
  for (const block of cssBlocks(path, content)) {
    if (block.dynamic) gaps.push({ code: 'DYNAMIC_STYLE_REVIEW', path })
    const css = block.content.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length))
    const stack = []
    let cursor = 0, quote = '', parentheses = 0
    for (let i = 0; i < css.length; i++) {
      const character = css[i]
      if (quote) { if (character === '\\') i++; else if (character === quote) quote = ''; continue }
      if (character === '"' || character === "'") { quote = character; continue }
      if (character === '(') parentheses++
      if (character === ')') parentheses--
      if (parentheses !== 0) continue
      if (character === '{') {
        stack.push({ selector: cleanSelector(css.slice(cursor, i)), start: i + 1, offset: cursor })
        cursor = i + 1
      } else if (character === '}') {
        const rule = stack.pop()
        if (rule && !rule.selector.startsWith('@')) {
          const body = css.slice(rule.start, i)
          if (!body.includes('{')) {
            const line = content.slice(0, block.offset + rule.offset).split('\n').length
            for (const declaration of declarationsIn(body)) rules.push({ path, line, selector: rule.selector, ...declaration })
          }
        }
        cursor = i + 1
      }
    }
    if (stack.length) gaps.push({ code: 'UNPARSED_STYLE_REVIEW', path })
  }
  return { rules, gaps }
}

export function isUiSource(path, content) {
  if (/\.d\.(?:ts|cts|mts)$/i.test(path)) return false // declarations are not executable screens
  if (!uiExtensions.has(extname(path).toLowerCase())) return false
  if (['.html', '.css', '.scss', '.less', '.tsx', '.jsx'].includes(extname(path).toLowerCase())) return true
  if (inspectUiSource(path, content).rules.length) return true
  // These are discoverability signals, not semantic violation detectors.
  return /\b(?:createElement|insertCSS|addStyle)\s*\(|\bslots\.(?:inject|register)\s*\(|\b(?:textContent|innerHTML|cssText)\s*=|\b(?:client|renderer)(?:[-.]|\/)/i.test(path + '\n' + content)
}

function validateCatalog(catalog, finding) {
  let invalid = false
  const emit = finding
  finding = (severity, ...args) => { if (severity === 'fail') invalid = true; emit(severity, ...args) }
  if (!catalog || catalog.schema !== 1 || !Array.isArray(catalog.sourceGroups) || !Array.isArray(catalog.surfaces) || !Array.isArray(catalog.exceptions)) {
    finding('fail', 'CATALOG_INVALID', 'schema:1, sourceGroups, surfaces and exceptions are required'); return false
  }
  const groupIds = new Set(), surfaceIds = new Set()
  for (const group of catalog.sourceGroups) {
    if (!group || !text(group.id) || groupIds.has(group.id) || !['repository', 'local-maintained', 'third-party'].includes(group.ownership) || !Array.isArray(group.sourceFiles) || group.sourceFiles.length > UI_AUDIT_LIMITS.maxFiles) {
      finding('fail', 'GROUP_INVALID', 'Source group id, ownership and explicit sourceFiles are required', { groupId: group?.id }); continue
    }
    groupIds.add(group.id)
    try {
      const root = uiSourcePath(group.ownedRoot)
      if (/^(?:Data|App|release|dist|node_modules|Tools|runtime[^/]*)($|\/)/i.test(root)) throw new Error('Generated/runtime roots are not owned UI scan roots; use an explicit @active local plugin boundary')
      if (root.startsWith('@active/') && !/^@active\/local\/[a-zA-Z0-9_-]+(?:\/.*)?$/.test(root) && !(group.ownership === 'third-party' && /^@active\/node_modules\/(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+(?:\/.*)?$/.test(root))) throw new Error('@active scan must be limited to one named local plugin or an explicit third-party package')
      if (root.startsWith('@runtime/') && !(group.ownership === 'third-party' && /^@runtime\/node_modules\/(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+(?:\/.*)?$/.test(root))) throw new Error('@runtime is read-only and limited to one explicitly named third-party package')
      for (const file of group.sourceFiles) {
        uiSourcePath(file)
        if (file !== root && !file.startsWith(root + '/')) throw new Error('Source file is outside its ownedRoot')
      }
      for (const ignored of group.ignoredSubtrees ?? []) {
        uiSourcePath(ignored.path)
        if (!text(ignored.reason)) throw new Error('Ignored subtree requires a reason')
        if (group.sourceFiles.some(file => file === root + '/' + ignored.path || file.startsWith(root + '/' + ignored.path + '/'))) throw new Error('Ignored subtree contains a registered source')
      }
    } catch (error) { finding('fail', 'PATH_INVALID', error.message, { groupId: group.id }) }
  }
  const registered = new Set(catalog.sourceGroups.filter(group => Array.isArray(group?.sourceFiles)).flatMap(group => group.sourceFiles))
  const sharedFiles = catalog.sharedSourceFiles ?? []
  if (!Array.isArray(sharedFiles) || new Set(sharedFiles).size !== sharedFiles.length) finding('fail', 'SHARED_SOURCE_INVALID', 'sharedSourceFiles must be an explicit, unique array')
  else for (const file of sharedFiles) {
    try { uiSourcePath(file) } catch (error) { finding('fail', 'PATH_INVALID', error.message) }
    if (!registered.has(file)) finding('fail', 'SHARED_SOURCE_NOT_REGISTERED', 'Global controlled source must belong to a registered source group', { path: file })
  }
  for (const surface of catalog.surfaces) {
    if (!surface || !text(surface.id) || surfaceIds.has(surface.id) || !groupIds.has(surface.groupId) || !text(surface.kind) || !text(surface.entry) || !Array.isArray(surface.roles)) {
      finding('fail', 'SURFACE_INVALID', 'Surface id, groupId, kind, entry and roles are required', { surfaceId: surface?.id }); continue
    }
    surfaceIds.add(surface.id)
    const group = catalog.sourceGroups.find(item => item.id === surface.groupId)
    if (surface.sourceFiles !== undefined && (!Array.isArray(surface.sourceFiles) || surface.sourceFiles.some(file => !group.sourceFiles.includes(file) && !(Array.isArray(sharedFiles) && sharedFiles.includes(file))))) finding('fail', 'SURFACE_SOURCE_OUTSIDE_GROUP', 'Cross-group surface sources must be explicitly registered global shared sources', { surfaceId: surface.id })
    for (const key of ['rootSelectors', 'requiredChecks']) if (surface[key] !== undefined && (!Array.isArray(surface[key]) || surface[key].some(value => !text(value)))) finding('fail', 'SURFACE_INVALID', key + ' must be an array of non-empty strings', { surfaceId: surface.id })
    const scopedGuest = surface.kind === 'external-content' && surface.boundary === 'guest-content' && text(surface.reason)
    if (!surface.roles.length && !scopedGuest) finding('blocked', 'ROLE_COVERAGE_MISSING', 'Surface has no declared semantic roles', { surfaceId: surface.id })
    const roleIds = new Set()
    for (const role of surface.roles) {
      if (!role || !text(role.id) || !text(role.property)) finding('fail', 'ROLE_INVALID', 'Each role requires id and CSS property', { surfaceId: surface.id })
      else if (roleIds.has(role.id)) finding('fail', 'ROLE_INVALID', 'Duplicate semantic role id', { surfaceId: surface.id, roleId: role.id })
      else if (!text(role.token)) finding('blocked', 'ROLE_TOKEN_MISSING', 'No shared token is declared for this role; do not invent a uniform size', { surfaceId: surface.id, roleId: role.id })
      if (role) roleIds.add(role.id)
    }
  }
  for (const exception of catalog.exceptions) {
    const scope = exception?.scope
    if (!text(exception?.reason) || !scope || !text(scope.source) || !text(scope.selector) || !text(scope.property) || !text(scope.value) || !text(scope.rule) || Object.values(scope).some(value => typeof value === 'string' && value.includes('*'))) {
      finding('fail', 'EXCEPTION_TOO_BROAD', 'Exceptions require an exact source, selector, property, value, rule and reason'); continue
    }
    try { uiSourcePath(scope.source) } catch (error) { finding('fail', 'PATH_INVALID', error.message) }
  }
  if (catalog.tokenDefinitions !== undefined && !Array.isArray(catalog.tokenDefinitions)) finding('fail', 'TOKEN_DEFINITION_INVALID', 'tokenDefinitions must be an array')
  else for (const definition of catalog.tokenDefinitions ?? []) {
    if (!text(definition?.token) || !/^--[a-zA-Z0-9_-]+$/.test(definition.token)) finding('fail', 'TOKEN_DEFINITION_INVALID', 'Token id must be a CSS custom property')
    try { uiSourcePath(definition?.source) } catch (error) { finding('fail', 'PATH_INVALID', error.message) }
  }
  if (!groupIds.size || !surfaceIds.size) finding('fail', 'CATALOG_EMPTY', 'At least one source group and surface are required')
  return !invalid
}

function excepted(catalog, rule, code) {
  return catalog.exceptions.some(exception => exception.scope?.rule === code && exception.scope.source === rule.path && cleanSelector(exception.scope.selector) === rule.selector && exception.scope.property === rule.property && cleanValue(exception.scope.value) === cleanValue(rule.value))
}

function sourceStatus(findings) { return findings.some(item => item.severity === 'fail') ? 'fail' : findings.some(item => item.severity === 'blocked') ? 'blocked' : 'pass' }

/** Pure fixture-friendly evaluation. artifactChecks can only be populated by
 * the bounded filesystem reader in auditUiConsistency; a JSON "verified" flag
 * cannot manufacture checked screenshots or real platform font samples. */
export function evaluateUiConsistency({ catalog, sources = [], discoveredUiSources = [], evidence, artifactChecks = {}, inputFindings = [], runtimeBinding }) {
  const findings = [...inputFindings]
  const finding = (severity, code, message, detail = {}) => findings.push({ severity, code, message, ...detail })
  let valid = validateCatalog(catalog, finding)
  const sourceMap = new Map()
  if (!Array.isArray(sources) || !Array.isArray(discoveredUiSources)) {
    finding('fail', 'SOURCE_INPUT_INVALID', 'sources and discoveredUiSources must be arrays'); valid = false
  } else for (const source of sources) {
    try {
      uiSourcePath(source.path)
      if (typeof source.content !== 'string' || sourceMap.has(source.path)) throw new Error('Source content must be text and paths must be unique')
      sourceMap.set(source.path, { ...source, sha256: sha(source.content) })
    } catch (error) { finding('fail', 'SOURCE_INPUT_INVALID', error.message); valid = false }
  }
  if (evidence !== undefined && (!Array.isArray(evidence?.surfaces) || evidence.surfaces.length > UI_AUDIT_LIMITS.maxFiles || new Set(evidence.surfaces.map(item => item?.id)).size !== evidence.surfaces.length)) {
    finding('fail', 'EVIDENCE_INPUT_INVALID', 'Evidence surfaces must be a bounded array with unique ids'); valid = false
  }
  const coverage = []
  if (runtimeBinding && evidence) {
    if (evidence.profile?.runtimeVersion !== runtimeBinding.runtimeVersion) finding('fail', 'RUNTIME_BINDING_DRIFT', 'Capture was taken under a different actual runtime version')
    if (!evidence.profile?.metadataHashes || typeof evidence.profile.metadataHashes !== 'object') finding('blocked', 'RUNTIME_METADATA_EVIDENCE_MISSING', 'Actual runtime/Profile metadata hashes are required for capture provenance')
    else for (const [path, fingerprint] of Object.entries(runtimeBinding.metadataHashes ?? {})) {
      if (!hashLike(evidence.profile.metadataHashes[path])) finding('blocked', 'RUNTIME_METADATA_EVIDENCE_MISSING', 'Capture omits actual controlled runtime/Profile metadata', { path })
      else if (evidence.profile.metadataHashes[path].toLowerCase() !== fingerprint) finding('fail', 'RUNTIME_METADATA_DRIFT', 'Capture runtime/Profile metadata differs from the actual selected combination', { path })
    }
  }
  if (valid) {
    const registered = new Set(catalog.sourceGroups.flatMap(group => group.sourceFiles))
    const thirdPartyFiles = new Set(catalog.sourceGroups.filter(group => group.ownership === 'third-party').flatMap(group => group.sourceFiles))
    for (const file of registered) if (!sourceMap.has(file)) finding(thirdPartyFiles.has(file) ? 'blocked' : 'fail', 'SOURCE_MISSING', 'Registered source could not be safely read', { path: file })
    for (const path of discoveredUiSources) if (!registered.has(path)) finding('fail', 'UNREGISTERED_UI_SOURCE', 'Owned UI source is not registered; gitignore does not exempt it', { path })
    const tokenSourceFiles = new Set((catalog.tokenDefinitions ?? []).map(definition => definition.source))
    const rules = [...sourceMap.values()].filter(source => (!thirdPartyFiles.has(source.path) || tokenSourceFiles.has(source.path)) && !/\.d\.(?:ts|cts|mts)$/i.test(source.path)).flatMap(source => {
      const inspected = inspectUiSource(source.path, source.content)
      if (!thirdPartyFiles.has(source.path)) for (const gap of inspected.gaps) finding('blocked', gap.code, 'Style extraction cannot establish complete source coverage', gap)
      return inspected.rules
    })
    const tokenDefinitions = new Map()
    for (const definition of catalog.tokenDefinitions ?? []) {
      const matches = rules.filter(rule => rule.path === definition.source && rule.property === definition.token)
      if (!text(definition.token) || !matches.length) finding('fail', 'TOKEN_DEFINITION_MISSING', 'Declared shared token is absent from its source', { path: definition.source, token: definition.token })
      else tokenDefinitions.set(definition.token, matches)
    }
    for (const surface of catalog.surfaces) {
      const group = catalog.sourceGroups.find(item => item.id === surface.groupId)
      if (!group) continue
      const localFiles = surface.sourceFiles ?? group.sourceFiles
      const surfaceFiles = [...new Set([...localFiles, ...(catalog.sharedSourceFiles ?? [])])]
      const surfaceRules = group.ownership === 'third-party' ? [] : rules.filter(rule => surfaceFiles.includes(rule.path))
      for (const selector of surface.rootSelectors ?? []) {
        for (const rule of surfaceRules.filter(rule => rule.selector.split(',').some(part => cleanSelector(part) === selector) && ['font-family', 'font'].includes(rule.property))) {
          if (!/^(?:inherit|var\(\s*--(?:dsh-font-ui|dcu-font|dsw-font-family))/.test(cleanValue(rule.value)) && !/\bvar\(\s*--(?:dsh-font-ui|dcu-font|dsw-font-family)/.test(rule.value) && !excepted(catalog, rule, 'ROOT_FAMILY_OVERRIDE')) {
            finding(/!important/i.test(rule.value) ? 'fail' : 'blocked', 'ROOT_FAMILY_OVERRIDE', 'Root family is not bound to the shared UI family; actual cascade must be checked', { surfaceId: surface.id, ...rule })
          }
        }
      }
      for (const role of surface.roles) {
        if (role?.token && !tokenDefinitions.has(role.token)) finding('blocked', 'ROLE_TOKEN_UNREGISTERED', 'Role token lacks a registered canonical definition', { surfaceId: surface.id, roleId: role.id, token: role.token })
        if (!role?.token || !role.selector || !role.property || group.ownership === 'third-party') continue
        const candidates = surfaceRules.filter(rule => (role.source ? rule.path === role.source : true) && rule.selector.split(',').some(part => cleanSelector(part) === cleanSelector(role.selector)) && rule.property === role.property)
        if (!candidates.length) { finding('blocked', 'ROLE_CONSUMER_MISSING', 'Declared role consumer is absent or requires runtime inheritance resolution', { surfaceId: surface.id, roleId: role.id }); continue }
        for (const rule of candidates) {
          const consumed = [...rule.value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1])
          const aliasesToken = token => token === role.token || (tokenDefinitions.get(token) ?? []).some(definition => definition.value.includes(`var(${role.token}`) || definition.value.includes(`var( ${role.token}`))
          if (consumed.some(aliasesToken) || (role.property === 'font-family' && cleanValue(rule.value) === 'inherit')) continue
          const values = tokenDefinitions.get(role.token)?.map(item => cleanValue(item.value)) ?? []
          const code = consumed.length || values.includes(cleanValue(rule.value)) ? 'ROLE_NOT_TOKEN_BOUND' : 'ROLE_VALUE_DRIFT'
          if (!excepted(catalog, rule, code)) finding(code === 'ROLE_VALUE_DRIFT' && values.length ? 'fail' : 'blocked', code, 'Role does not consume the declared shared token; fallbacks inside var() are not violations', { surfaceId: surface.id, roleId: role.id, token: role.token, ...rule })
        }
      }
      const observation = evidence?.surfaces?.find(item => item.id === surface.id)
      const row = { id: surface.id, state: 'unverified', accepted: false, sourceFiles: surfaceFiles }
      coverage.push(row)
      if (surface.kind === 'external-content' && surface.boundary === 'guest-content') {
        row.state = 'excluded-guest-content'
        if (!text(surface.reason)) finding('fail', 'GUEST_BOUNDARY_UNJUSTIFIED', 'Foreign content exemption requires a scoped reason', { surfaceId: surface.id })
        continue
      }
      if (!observation || !['captured', 'accepted'].includes(observation.state) || observation.real !== true || observation.isTrusted !== true || evidence?.schema !== 1 || evidence.kind !== 'real-profile-ui' || !Number.isFinite(Date.parse(evidence.capturedAt ?? ''))) {
        finding('blocked', 'UNVERIFIED_SURFACE', observation?.blockedReason ?? 'No complete real-profile capture for this surface', { surfaceId: surface.id }); continue
      }
      // v1 validates source snapshots and diagnostic UI artifacts, but has no
      // supported Loader-response or source-to-output receipt verifier. A copy
      // with equal bytes (including retained TS/templates) is not proof that
      // the captured renderer loaded/executed those bytes. Fail closed even if
      // JSON or a caller-supplied artifact flag says "verified".
      row.state = 'captured-source-unproven'
      row.sourceBindingVerified = false
      row.productionVerified = false
      row.runtimeScope = evidence.profile?.fixtureOnly === true ? 'isolated-candidate' : 'unverified'
      finding('blocked', 'SOURCE_BINDING_UNPROVEN', 'Diagnostic capture has no supported actual loaded/generated source-chain proof; source snapshots and equal copies are not loaded-byte evidence', { surfaceId: surface.id })
      if (observation.runtimeSourceEvidence !== undefined || evidence.runtimeSourceEvidence !== undefined) finding('blocked', 'SOURCE_BINDING_PROOF_UNSUPPORTED', 'v1 has no supported Loader trace/generation receipt parser; supplied proof labels or verified flags cannot establish source binding', { surfaceId: surface.id })
      if (!evidence.profile || !text(evidence.profile.runtimeVersion)) finding('blocked', 'RUNTIME_BINDING_MISSING', 'Capture must identify the actual Profile/runtime combination', { surfaceId: surface.id })
      if (observation.state === 'accepted') finding('blocked', 'ACCEPTANCE_NOT_VALIDATED', 'JSON accepted flag does not replace the separate reviewed preservation/acceptance workflow', { surfaceId: surface.id })
      for (const file of surfaceFiles) {
        if (sourceMap.get(file)?.sha256 !== observation.sourceHashes?.[file]?.toLowerCase()) finding('fail', 'SOURCE_DRIFT', 'Capture inputs do not match every controlled source of this surface', { surfaceId: surface.id, path: file })
      }
      const screenshot = observation.screenshot
      if (!screenshot || !hashLike(screenshot.sha256) || artifactChecks[surface.id]?.screenshot !== true) finding('blocked', 'MISSING_SCREENSHOT', 'A bounded, readable, hash-matched PNG capture is required', { surfaceId: surface.id })
      for (const role of surface.roles) {
        const sample = observation.roles?.find(item => item.id === role.id)
        if (!text(sample?.computedValue) || !text(sample?.expectedValue)) finding('blocked', 'MISSING_STYLE_SAMPLE', 'Computed role and live token values are required', { surfaceId: surface.id, roleId: role.id })
        else if (cleanValue(sample.computedValue) !== cleanValue(sample.expectedValue)) finding('fail', 'STYLE_TOKEN_MISMATCH', 'Actual computed style differs from its actual shared token', { surfaceId: surface.id, roleId: role.id, actual: sample.computedValue, expected: sample.expectedValue })
        if (role.property === 'font-family' && (!text(sample?.fontFamily) || !Array.isArray(sample?.platformFonts) || !sample.platformFonts.some(font => text(font.familyName) && font.glyphCount > 0))) finding('blocked', 'MISSING_FONT_SAMPLE', 'Non-empty actual platform font usage is required, not a CSS family string alone', { surfaceId: surface.id, roleId: role.id })
      }
      for (const check of surface.requiredChecks ?? ['focus', 'responsive', 'paint']) if (observation.checks?.[check] !== true) finding('blocked', 'RUNTIME_CHECK_MISSING', 'Applicable interaction/layout check is incomplete', { surfaceId: surface.id, check })
      // Captured is not accepted. Accepting sources belongs to the existing
      // reviewed preservation workflow, never to this scanner or a fixture.
    }
  }
  return { schema: 1, kind: 'ui-consistency-audit', status: sourceStatus(findings), acceptance: 'not-performed', runtimeSourceVerification: 'unsupported-v1', findings, coverage, sourceHashes: Object.fromEntries([...sourceMap].map(([path, value]) => [path, value.sha256])) }
}

function within(root, path) { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) }

async function plainPath(repositoryRoot, relativePath, directory = false, allowReadOnlyHardLinks = false) {
  uiSourcePath(relativePath)
  const full = resolve(repositoryRoot, relativePath)
  if (!within(repositoryRoot, full)) throw new Error('Path escapes repository')
  let cursor = repositoryRoot
  for (const part of relativePath.split('/')) {
    cursor = resolve(cursor, part)
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink() || (cursor !== full && !stat.isDirectory())) throw new Error('Link or non-directory ancestor is forbidden')
  }
  const stat = await lstat(full)
  if (directory ? !stat.isDirectory() : !stat.isFile() || (stat.nlink !== 1 && !allowReadOnlyHardLinks)) throw new Error('Not a plain owned ' + (directory ? 'directory' : 'file'))
  // win32：磁盘规范拼写大小写可能与输入拼写不同（同一路径），规范性等值按平台语义比较。
  const fullReal = resolve(await realpath(full))
  const canonical = process.platform === 'win32' ? fullReal.toLowerCase() === full.toLowerCase() : fullReal === full
  if (!canonical) throw new Error('Source path is not canonical')
  return { full, stat }
}

/** Mirror the launcher's home binding semantics without guessing an old home,
 * interpreting a version directory, or accepting a different runtime slot. */
export function runtimeBindingPaths(pointer, binding) {
  const current = pointer?.current
  if (pointer?.schema !== 1 || !current || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(current.version ?? '') || !/^Harness\/slots\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(current.relativePath ?? '')) throw new Error('Invalid active runtime pointer')
  if (Object.hasOwn(pointer, 'pendingTransactionId')) throw new Error('Uncommitted runtime transaction blocks source selection')
  const slot = `Data/Runtime/${current.relativePath}`
  if (binding === undefined) return { runtimeVersion: current.version, runtimeRelativePath: slot, profileRelativePath: 'Data/DSH/profiles/web' }
  if (![1, 2].includes(binding?.schema) || binding.runtimeVersion !== current.version || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(binding.generation ?? '')) throw new Error('Invalid runtime/home binding; fallback forbidden')
  if (binding.schema === 2 && binding.runtimeRelativePath !== slot) throw new Error('Runtime/home binding references a different slot; fallback forbidden')
  return { runtimeVersion: current.version, runtimeRelativePath: binding.schema === 1 ? `Data/DSH-generations/${binding.generation}/runtime/dsh-runtime` : slot, profileRelativePath: `Data/DSH-generations/${binding.generation}/home/profiles/web` }
}

async function plainJson(root, path, allowReadOnlyHardLinks = false) {
  const { full, stat } = await plainPath(root, path, false, allowReadOnlyHardLinks)
  if (stat.size > 256 * 1024) throw new Error('Runtime metadata byte budget exceeded')
  const bytes = await readFile(full)
  const after = await lstat(full)
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || after.isSymbolicLink()) throw new Error('Runtime metadata changed during source selection')
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha(bytes) }
}

export async function resolveUiRuntimeAnchor(repositoryRoot) {
  const root = resolve(repositoryRoot)
  const selected = activeUiProfile(root) // preserves pending and home validation
  const pointer = await plainJson(root, 'Data/Runtime/Harness/current.json')
  const bindingPath = `Data/Updates/Harness/homes/${pointer.value?.current?.version}.json`
  let binding
  try { binding = await plainJson(root, bindingPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const paths = runtimeBindingPaths(pointer.value, binding?.value)
  if (selected.profile !== resolve(root, paths.profileRelativePath)) throw new Error('Active Profile changed during runtime source selection')
  await plainPath(root, paths.runtimeRelativePath, true)
  const runtimePackage = paths.runtimeRelativePath + '/node_modules/@deepseek-ai/dsh'
  const identity = await plainJson(root, runtimePackage + '/package.json')
  if (identity.value.name !== '@deepseek-ai/dsh' || identity.value.version !== paths.runtimeVersion) throw new Error('Actual runtime package identity/version does not match current binding')
  await plainPath(root, runtimePackage + '/lib/bin.js')
  const profile = await plainJson(root, paths.profileRelativePath + '/package.json')
  const after = await plainJson(root, 'Data/Runtime/Harness/current.json')
  if (after.sha256 !== pointer.sha256) throw new Error('Runtime pointer changed during source selection')
  if (binding && (await plainJson(root, bindingPath)).sha256 !== binding.sha256) throw new Error('Runtime/home binding changed during source selection')
  if (!binding) {
    try { await plainJson(root, bindingPath); throw new Error('Runtime/home binding appeared during source selection') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { ...paths, runtimeRoot: resolve(root, paths.runtimeRelativePath), metadataHashes: { 'Data/Runtime/Harness/current.json': pointer.sha256, [runtimePackage + '/package.json']: identity.sha256, [paths.profileRelativePath + '/package.json']: profile.sha256, ...(binding ? { [bindingPath]: binding.sha256 } : {}) } }
}

/** Safe filesystem adapter: explicit owned roots, bounded traversal, no links,
 * no gitignore filtering, no Data writes and no automatic evidence creation. */
export async function auditUiConsistency({ repositoryRoot, catalog, evidence, evidenceRoot, limits = {} }) {
  const bounds = { ...UI_AUDIT_LIMITS, ...limits }
  for (const key of Object.keys(UI_AUDIT_LIMITS)) if (!Number.isInteger(bounds[key]) || bounds[key] <= 0 || bounds[key] > UI_AUDIT_LIMITS[key]) throw new Error('Audit bounds may only be tightened')
  const root = resolve(repositoryRoot), rootStat = await lstat(root)
  // win32：磁盘规范拼写大小写可能与输入拼写不同（同一路径两种大小写）；符号链接拒绝
  // 已由 lstat 承担，规范性等值按平台大小写语义比较，别把环境变量拼写当判据。
  const rootReal = resolve(await realpath(root))
  const canonicalRoot = process.platform === 'win32' ? rootReal.toLowerCase() === root.toLowerCase() : rootReal === root
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !canonicalRoot) throw new Error('Repository root must be a plain canonical directory')
  const sources = [], discoveredUiSources = [], inputFindings = [], artifactChecks = {}, seen = new Set()
  let count = 0, totalBytes = 0
  const issue = (code, message, path, severity = 'fail') => inputFindings.push({ severity, code, message, ...(path ? { path } : {}) })
  if (!validateCatalog(catalog, () => {})) return evaluateUiConsistency({ catalog })
  let activeProfile, runtimeAnchor
  const packageIdentities = new Map()
  const physical = async path => {
    if (path.startsWith('@runtime/')) {
      runtimeAnchor ??= await resolveUiRuntimeAnchor(root)
      const match = path.match(/^@runtime\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/)
      if (!match) throw new Error('@runtime source must refer to a named package file')
      const packagePath = runtimeAnchor.runtimeRelativePath + '/node_modules/' + match[1]
      if (!packageIdentities.has(packagePath)) {
        const identity = await plainJson(root, packagePath + '/package.json')
        if (identity.value.name !== match[1] || (match[1].startsWith('@deepseek-ai/dsh') && identity.value.version !== runtimeAnchor.runtimeVersion)) throw new Error('Runtime UI package identity/version mismatch')
        packageIdentities.set(packagePath, { version: identity.value.version, sha256: identity.sha256 })
      }
      return packagePath + '/' + match[2]
    }
    if (!path.startsWith('@active/')) return path
    runtimeAnchor ??= await resolveUiRuntimeAnchor(root)
    activeProfile ??= activeUiProfile(root).profile
    if (!within(root, activeProfile)) throw new Error('Active profile lies outside the portable repository')
    if (path.startsWith('@active/node_modules/')) {
      const match = path.match(/^@active\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/)
      if (!match || !thirdPartyFiles.has(path)) throw new Error('Active package source must be an explicitly registered read-only third-party file')
      const group = catalog.sourceGroups.find(group => group.ownership === 'third-party' && group.sourceFiles.includes(path))
      if (!text(group?.inventoryVersion)) throw new Error('Third-party package inventoryVersion is required')
      const packagePath = relative(root, resolve(activeProfile, 'node_modules', match[1])).split(sep).join('/')
      if (!packageIdentities.has(packagePath)) {
        const identity = await plainJson(root, packagePath + '/package.json', true)
        if (identity.value.name !== match[1] || identity.value.version !== group.inventoryVersion) throw Object.assign(new Error('Source package name/version differs from the captured inventory'), { code: 'SOURCE_IDENTITY_DRIFT' })
        packageIdentities.set(packagePath, { version: identity.value.version, sha256: identity.sha256, allowReadOnlyHardLinks: true })
      }
    }
    return relative(root, resolve(activeProfile, path.slice('@active/'.length))).split(sep).join('/')
  }
  const thirdPartyFiles = new Set(catalog.sourceGroups.filter(group => group.ownership === 'third-party').flatMap(group => group.sourceFiles))
  const readSource = async path => {
    if (seen.has(path)) return
    seen.add(path)
    try {
      if (++count > bounds.maxFiles) throw new Error('File count budget exceeded')
      const allowReadOnlyHardLinks = path.startsWith('@active/node_modules/') && thirdPartyFiles.has(path)
      const { full, stat } = await plainPath(root, await physical(path), false, allowReadOnlyHardLinks)
      if (stat.size > bounds.maxBytesPerFile || (totalBytes += stat.size) > bounds.maxTotalBytes) throw new Error('Source byte budget exceeded')
      const bytes = await readFile(full)
      const after = await lstat(full)
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || after.isSymbolicLink()) throw new Error('Source changed while being read')
      const content = bytes.toString('utf8')
      sources.push({ path, content })
      if (isUiSource(path, content)) discoveredUiSources.push(path)
    } catch (error) { issue(error.code === 'SOURCE_IDENTITY_DRIFT' ? error.code : 'SOURCE_READ_BLOCKED', error.message, path, error.code === 'SOURCE_IDENTITY_DRIFT' ? 'fail' : thirdPartyFiles.has(path) ? 'blocked' : 'fail') }
  }
  for (const group of catalog.sourceGroups) {
    for (const path of group.sourceFiles) await readSource(path)
    if (group.ownership === 'third-party') continue // explicit file read only
    const visit = async (path, depth) => {
      if (count > bounds.maxFiles || totalBytes > bounds.maxTotalBytes) return
      if (depth > bounds.maxDepth) { issue('SCAN_DEPTH_EXCEEDED', 'Owned root scan depth exceeded', path); return }
      try {
        const { full } = await plainPath(root, await physical(path), true)
        const entries = await readdir(full, { withFileTypes: true })
        if (entries.length > bounds.maxFiles) throw new Error('Directory entry budget exceeded')
        for (const entry of entries) {
          const child = path + '/' + entry.name
          const ignored = (group.ignoredSubtrees ?? []).some(item => child === group.ownedRoot + '/' + item.path || child.startsWith(group.ownedRoot + '/' + item.path + '/'))
          if (ignored) continue
          if (entry.isSymbolicLink()) { issue('LINK_NOT_SCANNED', 'Owned source tree contains a link; no traversal performed', child); continue }
          if (entry.isDirectory()) await visit(child, depth + 1)
          else if (entry.isFile() && uiExtensions.has(extname(child).toLowerCase())) await readSource(child)
          if (count > bounds.maxFiles || totalBytes > bounds.maxTotalBytes) break
        }
      } catch (error) { issue('OWNED_ROOT_BLOCKED', error.message, path) }
    }
    await visit(group.ownedRoot, 0)
  }
  if (evidence?.surfaces && evidenceRoot) {
    const artifactRoot = resolve(evidenceRoot)
    const artifactStat = await lstat(artifactRoot)
    if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink() || resolve(await realpath(artifactRoot)) !== artifactRoot) throw new Error('Evidence root must be a plain canonical directory')
    for (const observation of evidence.surfaces) {
      try {
        const capture = observation.screenshot
        if (!capture || !text(capture.path) || !hashLike(capture.sha256)) continue
        const file = resolve(artifactRoot, capture.path)
        if (!within(artifactRoot, file)) throw new Error('Screenshot outside explicit evidence root')
        const local = relative(artifactRoot, file).split(sep).join('/')
        const { full, stat } = await plainPath(artifactRoot, local)
        if (stat.size > bounds.maxBytesPerFile * 8) throw new Error('Screenshot byte budget exceeded')
        const bytes = await readFile(full)
        const png = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.includes(Buffer.from('IDAT')) && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND'
        artifactChecks[observation.id] = { screenshot: png && sha(bytes) === capture.sha256.toLowerCase() }
      } catch (error) { issue('SCREENSHOT_READ_BLOCKED', error.message, undefined, 'blocked') }
    }
  }
  if (runtimeAnchor) {
    for (const [path, fingerprint] of Object.entries(runtimeAnchor.metadataHashes)) {
      try { if ((await plainJson(root, path)).sha256 !== fingerprint) issue('RUNTIME_METADATA_DRIFT', 'Runtime/Profile metadata changed during the audit', path) }
      catch (error) { issue('RUNTIME_METADATA_DRIFT', error.message, path) }
    }
  }
  for (const [path, identity] of packageIdentities) {
    try { if ((await plainJson(root, path + '/package.json', identity.allowReadOnlyHardLinks === true)).sha256 !== identity.sha256) issue('RUNTIME_METADATA_DRIFT', 'Runtime UI package identity changed during the audit', path) }
    catch (error) { issue('RUNTIME_METADATA_DRIFT', error.message, path) }
  }
  const report = evaluateUiConsistency({ catalog, sources, discoveredUiSources, evidence, artifactChecks, inputFindings, runtimeBinding: runtimeAnchor })
  if (runtimeAnchor) report.runtimeBinding = { runtimeVersion: runtimeAnchor.runtimeVersion, runtimeRelativePath: runtimeAnchor.runtimeRelativePath, profileRelativePath: runtimeAnchor.profileRelativePath, metadataHashes: runtimeAnchor.metadataHashes }
  return report
}
