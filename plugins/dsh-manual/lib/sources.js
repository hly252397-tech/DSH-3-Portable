import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_SOURCES = Object.freeze([
  { path: 'docs/00-交接入口/07-功能清单.md', title: 'DSH 功能清单', module: 'dsh' },
  { path: 'docs/03-技术架构/00-桌面启动器架构基线.md', title: '桌面启动与便携结构', module: 'desktop' },
  { path: 'docs/03-技术架构/DeepSeek-Harness-官方兼容基线.md', title: '运行时版本与兼容基线', module: 'runtime' },
  { path: 'docs/03-技术架构/构建更新与定制防回退规则.md', title: '构建更新与定制防回退规则', module: 'desktop' },
  { path: 'docs/05-系统认知/01-产品全貌与系统概览.md', title: '产品全貌与系统概览', module: 'dsh' },
  { path: 'plugins/dsh-system-awareness/README.md', title: '系统认知使用说明', module: 'dsh-system-awareness' },
  { path: 'plugins/dsh-manual/README.md', title: '可编辑手册使用说明', module: 'dsh-manual' },
  { path: 'Data/DSH/profiles/web/local/dsh-black-hole/README.md', title: '黑洞空间使用说明', module: 'dsh-black-hole' },
  { path: 'Data/DSH/profiles/web/local/dsh-better-sidebar/README.md', title: '侧栏与工作区使用说明', module: 'dsh-better-sidebar' },
])

export function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function manualError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details })
}

const legacyLocal = 'Data/DSH/profiles/web/local'
const profilePath = /^(?:Data\/DSH|Data\/DSH-generations\/[a-z0-9][a-z0-9_-]{0,95}\/home)\/profiles\/web$/iu
const localDocument = /^(?:Data\/DSH|Data\/DSH-generations\/[a-z0-9][a-z0-9_-]{0,95}\/home)\/profiles\/web\/local\/(.+)$/iu

function inside(root, directory) {
  const relative = path.relative(root, directory)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw manualError('UNSAFE_PATH', '来源或 Profile 超出明确的便携根目录。')
  }
}

export function activeLocalRelative(root, profileDir) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw manualError('INVALID_SOURCE', '活动 Profile 必须是绝对路径。')
  inside(path.resolve(root), path.resolve(profileDir))
  const relative = path.relative(path.resolve(root), path.resolve(profileDir)).split(path.sep).join('/')
  if (!profilePath.test(relative)) throw manualError('INVALID_SOURCE', '活动 Profile 不属于受支持的便携家园。')
  return `${relative}/local`
}

/** No cwd/ancestor guessing. An explicit sourceRoot retains its relative/absolute meaning. */
export async function resolveManualSourceContext({ sourceRoot = 'auto', portableRoot, profileDir, home } = {}) {
  if (typeof sourceRoot !== 'string' || typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) {
    throw manualError('INVALID_SOURCE', '来源配置或实际 Profile 位置无效。')
  }
  let localSourceRoot = null
  let activeProfileDir = null
  if (portableRoot !== undefined && portableRoot !== '') {
    if (typeof portableRoot !== 'string' || !path.isAbsolute(portableRoot)) throw manualError('INVALID_SOURCE', 'DSH_PORTABLE_ROOT 必须是明确的绝对目录。')
    localSourceRoot = await ensurePlainDirectory(portableRoot)
    if (typeof home !== 'string' || !path.isAbsolute(home) || path.resolve(profileDir) !== path.resolve(home, 'profiles', 'web')) {
      throw manualError('INVALID_SOURCE', '活动 Profile 与实际 DSH home 不匹配。')
    }
    activeLocalRelative(localSourceRoot, profileDir)
    await ensurePlainDirectory(home)
    activeProfileDir = await ensurePlainDirectory(profileDir)
  } else if (sourceRoot === 'auto') {
    throw manualError('INVALID_SOURCE', '自动来源需要 DSH_PORTABLE_ROOT；未猜测其他仓库或家园。')
  }
  const resolvedSource = sourceRoot === 'auto' ? localSourceRoot : path.resolve(profileDir, sourceRoot)
  if (localSourceRoot) inside(localSourceRoot, resolvedSource)
  await ensurePlainDirectory(resolvedSource)
  return { sourceRoot: resolvedSource, localSourceRoot, activeProfileDir }
}

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\\') || /[\x00-\x1f<>:"|?*%]/u.test(value)) {
    throw manualError('UNSAFE_PATH', '路径必须为规范的相对路径。')
  }
  if (value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(part))) {
    throw manualError('UNSAFE_PATH', '路径含有不允许的片段。')
  }
  return value
}

// Reject junctions as well as symbolic links, including ancestors of the root.
// A local process with write access to these directories is outside this API's trust boundary.
export async function ensurePlainDirectory(directory, create = false) {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error
      try { await fs.mkdir(current) } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError }
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw manualError('UNSAFE_PATH', '目录链接或非目录路径不可作为手册数据路径。')
  }
  return absolute
}

export async function resolveSafeFile(root, relative, createParents = false) {
  safeRelative(relative)
  const resolvedRoot = await ensurePlainDirectory(root, createParents)
  const target = path.join(resolvedRoot, ...relative.split('/'))
  await ensurePlainDirectory(path.dirname(target), createParents)
  try {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw manualError('UNSAFE_PATH', '文件链接或特殊文件不可作为手册数据。')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return target
}

export async function readSafeFile(root, relative, maxBytes) {
  const target = await resolveSafeFile(root, relative)
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink > 1) throw manualError('UNSAFE_PATH', '不允许读取链接或特殊文件。')
    if (stat.size > maxBytes) throw manualError('DOCUMENT_TOO_LARGE', '文件超过读取大小上限。')
    // Bounded even if an external editor grows the file after stat().
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const chunk = await handle.read(buffer, size, buffer.length - size, size)
      if (!chunk.bytesRead) break
      size += chunk.bytesRead
    }
    if (size > maxBytes) throw manualError('DOCUMENT_TOO_LARGE', '文件超过读取大小上限。')
    return buffer.subarray(0, size).toString('utf8')
  } finally { await handle.close() }
}

export function validateSource(entry) {
  const spec = typeof entry === 'string' ? { path: entry } : entry
  if (!spec || typeof spec !== 'object') throw manualError('INVALID_SOURCE', '来源必须是相对文件路径或来源描述。')
  const relative = safeRelative(spec.path)
  const publicDoc = /^docs\/(?:00-交接入口|03-技术架构|05-系统认知)\/[^/]+\.md$/u.test(relative)
  const pluginDoc = /^(?:plugins\/[a-z0-9][a-z0-9._-]*|(?:Data\/DSH|Data\/DSH-generations\/[a-z0-9][a-z0-9_-]{0,95}\/home)\/profiles\/web\/local\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)\/(?:README(?:\.[a-zA-Z-]+)?\.md|package\.json)$/u.test(relative)
  if (!publicDoc && !pluginDoc) throw manualError('SOURCE_NOT_ALLOWED', '仅接受限定文档目录和指定插件的 README/package.json。')
  const identityPath = sourceIdentity(relative)
  if (spec.identityPath !== undefined && spec.identityPath !== identityPath) throw manualError('INVALID_SOURCE', '来源身份不能重定向到其他章节。')
  return {
    path: relative,
    ...(localDocument.test(relative) ? { identityPath } : {}),
    title: typeof spec.title === 'string' ? spec.title.slice(0, 200) : path.posix.basename(relative, '.md'),
    module: typeof spec.module === 'string' ? spec.module.slice(0, 120) : 'dsh',
  }
}

export function sourceId(relative) {
  return `generated/source-${digest(sourceIdentity(relative)).slice(0, 24)}`
}

// Keep existing legacy generated chapter/history IDs across generation changes.
export function sourceIdentity(relative) {
  const match = localDocument.exec(relative)
  return match ? `${legacyLocal}/${match[1]}` : relative
}

export function defaultSourcesForProfile(root, profileDir) {
  if (profileDir === undefined) return DEFAULT_SOURCES.map(validateSource)
  const local = profileDir === null ? null : activeLocalRelative(root, profileDir)
  return DEFAULT_SOURCES.filter(spec => local !== null || !spec.path.startsWith(`${legacyLocal}/`))
    .map(spec => validateSource({ ...spec, path: spec.path.startsWith(`${legacyLocal}/`) ? `${local}/${spec.path.slice(legacyLocal.length + 1)}` : spec.path }))
}

const localPackagePart = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/**
 * Discover only local, installed plugin documentation. This is intentionally
 * narrower than a repository walk: it follows the Profile's copied/junction-
 * free `local` tree and accepts only README/package metadata.
 */
export async function discoverLocalSources(root, maxSources = 128, profileDir) {
  if (profileDir === null) return []
  const localRelative = profileDir === undefined ? legacyLocal : activeLocalRelative(root, profileDir)
  let local
  try { local = await ensurePlainDirectory(path.join(root, ...localRelative.split('/'))) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  const add = async (relativePackage, directory) => {
    if (!localPackagePart.test(relativePackage)) return
    let packageJson
    try { packageJson = JSON.parse(await readSafeFile(root, `${localRelative}/${relativePackage}/package.json`, 128 * 1024)) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    const title = typeof packageJson.description === 'string' && packageJson.description.trim()
      ? packageJson.description.slice(0, 200) : relativePackage
    const module = typeof packageJson.name === 'string' ? packageJson.name.slice(0, 120) : relativePackage
    const candidates = [`${localRelative}/${relativePackage}/package.json`]
    for (const name of ['README.md', 'README.zh.md', 'README.en.md']) {
      try {
        await readSafeFile(root, `${localRelative}/${relativePackage}/${name}`, 256 * 1024)
        candidates.push(`${localRelative}/${relativePackage}/${name}`)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const relativePath of candidates) {
      try { entries.push(validateSource({ path: relativePath, title, module })) } catch { /* bounded discovery skips invalid entries */ }
      if (entries.length >= maxSources) return
    }
    void directory
  }
  const scan = async (directory, prefix = '') => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= maxSources || entry.name === 'node_modules') continue
      if (entry.isSymbolicLink()) throw manualError('UNSAFE_PATH', '活动本地插件文档不能通过目录链接读取。')
      const full = path.join(directory, entry.name)
      if (prefix === '' && entry.name.startsWith('@') && entry.isDirectory()) {
        for (const child of (await fs.readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entries.length >= maxSources) continue
          if (child.isSymbolicLink()) throw manualError('UNSAFE_PATH', '活动本地插件文档不能通过目录链接读取。')
          if (!child.isDirectory()) continue
          await add(`${entry.name}/${child.name}`, path.join(full, child.name))
        }
      } else if (prefix === '' && entry.isDirectory()) {
        await add(entry.name, full)
      }
    }
  }
  await scan(local)
  return entries
}

export function redactSource(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)-?[a-zA-Z0-9_]{20,}\b/gu, '[REDACTED TOKEN]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gu, '$1[REDACTED]@')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|authorization)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/giu, '$1[REDACTED]')
}

export async function collectSource(root, entry, maxBytes = 256 * 1024) {
  const spec = validateSource(entry)
  const raw = await readSafeFile(root, spec.path, maxBytes)
  let content = raw
  let version
  if (spec.path.endsWith('/package.json')) {
    const json = JSON.parse(raw)
    // Credentials, scripts, local paths and dependencies never enter package facts.
    version = typeof json.version === 'string' ? json.version.slice(0, 100) : undefined
    content = `# ${spec.title}\n\n${JSON.stringify({
      name: typeof json.name === 'string' ? json.name.slice(0, 150) : undefined,
      version,
      description: typeof json.description === 'string' ? json.description.slice(0, 4000) : undefined,
    }, null, 2)}\n`
  }
  return { ...spec, hash: digest(raw), version, content: redactSource(content) }
}
