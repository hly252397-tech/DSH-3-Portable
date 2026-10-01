import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { collectSource, defaultSourcesForProfile, digest, discoverLocalSources, ensurePlainDirectory, manualError, readSafeFile, resolveSafeFile, sourceId, sourceIdentity, validateSource } from './sources.js'
import { MANUAL_SEEDS } from './seeds.js'

export const MANUAL_ERROR_CODES = Object.freeze([
  'INVALID_ID', 'INVALID_ARGUMENT', 'UNSAFE_PATH', 'SOURCE_NOT_ALLOWED', 'INVALID_SOURCE',
  'NOT_FOUND', 'READ_ONLY', 'REVISION_CONFLICT', 'DOCUMENT_TOO_LARGE', 'RESULT_TOO_SMALL',
  'LOCK_TIMEOUT', 'LOCK_ORPHANED', 'HISTORY_CORRUPT', 'ABORTED',
])

const HEADER = '<!-- dsh-manual:'
const REVISION = /^[a-f0-9]{64}$/u
const DEFAULT_MAX_DOCUMENT_BYTES = 256 * 1024

function integer(value, fallback, min, max, name) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw manualError('INVALID_ARGUMENT', `${name} 超出允许范围。`)
  return resolved
}

function shortText(value, fallback, max = 200) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b-\x1f]/u.test(value)) throw manualError('INVALID_ARGUMENT', '文本元数据无效或过长。')
  return value
}

function validId(id) {
  if (typeof id !== 'string' || id.length > 180 || !/^(?:notes|generated)\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*){0,3}$/u.test(id)) {
    throw manualError('INVALID_ID', '章节 ID 应为 notes/名称 或 generated/名称，仅使用小写字母、数字、下划线和短横线。')
  }
  return id
}

function abort(signal) {
  if (signal?.aborted) throw manualError('ABORTED', '手册操作已取消。')
}

function parseRaw(id, raw) {
  const kind = id.startsWith('generated/') ? 'generated' : 'note'
  let stored = {}
  let content = raw
  let metadataInvalid = false
  if (raw.startsWith(HEADER)) {
    const end = raw.indexOf(' -->\n')
    if (end >= 0 && end < 8192) {
      try {
        const parsed = JSON.parse(raw.slice(HEADER.length, end))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid header')
        stored = parsed
        content = raw.slice(end + 5).replace(/^\n/u, '')
      } catch { metadataInvalid = true }
    } else metadataInvalid = true
  }
  const title = typeof stored.title === 'string' ? stored.title.slice(0, 200) : (content.match(/^#\s+(.+)$/mu)?.[1]?.slice(0, 200) ?? id)
  const source = stored.source && typeof stored.source === 'object' && typeof stored.source.path === 'string'
    ? {
        path: stored.source.path.slice(0, 500),
        hash: typeof stored.source.hash === 'string' && REVISION.test(stored.source.hash) ? stored.source.hash : null,
        syncedAt: typeof stored.source.syncedAt === 'string' ? stored.source.syncedAt.slice(0, 40) : null,
        ...(typeof stored.source.version === 'string' ? { version: stored.source.version.slice(0, 100) } : {}),
        ...(typeof stored.source.identityPath === 'string' ? { identityPath: stored.source.identityPath.slice(0, 500) } : {}),
      } : undefined
  const editedExternally = kind === 'generated' && (!REVISION.test(stored.generatedContentHash ?? '') || digest(content) !== stored.generatedContentHash)
  return {
    id, title, kind, status: kind === 'generated' ? 'reference' : 'draft',
    revision: digest(raw), content,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt.slice(0, 40) : null,
    author: typeof stored.author === 'string' ? stored.author.slice(0, 120) : 'external',
    module: typeof stored.module === 'string' ? stored.module.slice(0, 120) : 'dsh',
    freshness: ['current', 'stale', 'unavailable', 'bundled'].includes(stored.freshness) ? stored.freshness : 'unavailable',
    ...(source ? { source } : {}), metadataInvalid, editedExternally,
  }
}

function encodeRaw(id, content, metadata) {
  // Escaping HTML delimiters keeps the metadata in one inert Markdown comment.
  const header = JSON.stringify({ schemaVersion: 1, ...metadata, id }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  return `${HEADER}${header} -->\n\n${content}`
}

function summary(document) {
  const { content, ...metadata } = document
  return { ...metadata, contentLength: content.length }
}

function byteSize(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }

function diagnostic(id, error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]{2,60}$/u.test(error.code) ? error.code : 'DOCUMENT_UNAVAILABLE'
  return { id, code }
}

function boundPage(items, total, offset, limit, maxBytes, scanTruncated = false, issues = []) {
  const selected = items.slice(offset, offset + limit)
  const result = { items: selected, total, offset, nextOffset: null, truncated: false, scanTruncated, ...(issues.length ? { issues: issues.slice(0, 64) } : {}) }
  const update = () => {
    result.nextOffset = offset + selected.length < total ? offset + selected.length : null
    result.truncated = result.nextOffset !== null || scanTruncated
  }
  update()
  while (byteSize(result) > maxBytes && selected.length) { selected.pop(); update() }
  if (byteSize(result) > maxBytes || (!selected.length && offset < total)) throw manualError('RESULT_TOO_SMALL', '结果字节预算不足以返回一条记录。')
  return result
}

/** Markdown is authoritative; there is deliberately no mandatory database/index. */
export function createManualStore(options = {}) {
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root)) throw manualError('INVALID_ARGUMENT', '手册根目录必须是绝对路径。')
  const root = path.resolve(options.root)
  const sourceRoot = options.sourceRoot === undefined ? null : path.resolve(options.sourceRoot)
  const localSourceRoot = options.localSourceRoot == null ? sourceRoot : path.resolve(options.localSourceRoot)
  const explicitSources = options.sources !== undefined
  const baseSources = options.sources === undefined ? defaultSourcesForProfile(localSourceRoot ?? root, options.activeProfileDir) : options.sources.map(validateSource)
  let sources = [...baseSources]
  if (sources.length > 128 || new Set(sources.map((source) => sourceId(source.path))).size !== sources.length) throw manualError('INVALID_ARGUMENT', '来源最多 128 项且章节身份不得重复。')
  const maxDocumentBytes = integer(options.maxDocumentBytes, DEFAULT_MAX_DOCUMENT_BYTES, 1024, 4 * 1024 * 1024, 'maxDocumentBytes')
  const maxResultBytes = integer(options.maxResultBytes, 512 * 1024, 1024, 8 * 1024 * 1024, 'maxResultBytes')
  const maxDocuments = integer(options.maxDocuments, 512, 1, 10000, 'maxDocuments')
  const lockTimeoutMs = integer(options.lockTimeoutMs, 10000, 10, 120000, 'lockTimeoutMs')
  // Optional filesystem seam used to prove failed rename never deletes the old file.
  const rename = options.io?.rename ?? fs.rename
  let initialization
  let discoveryIssue

  const sourceDirectory = spec => spec.identityPath ? localSourceRoot : sourceRoot

  async function refreshSources() {
    if (explicitSources || !localSourceRoot || options.activeProfileDir === null) return
    discoveryIssue = undefined
    try {
      const discovered = await discoverLocalSources(localSourceRoot, 128, options.activeProfileDir)
      const merged = new Map(baseSources.map((source) => [sourceId(source.path), source]))
      for (const source of discovered) if (!merged.has(sourceId(source.path))) merged.set(sourceId(source.path), source)
      sources = [...merged.values()].slice(0, 128)
    } catch (error) {
      // Do not make existing editable notes unavailable because discovery failed.
      // Nor silently declare a partial/unsafe discovery to be a successful sync.
      discoveryIssue = { id: 'generated/source-context', source: 'active-profile', code: diagnostic('source-context', error).code, message: '活动插件来源发现失败，未改笔记或切换到旧家园。' }
    }
  }

  async function withLock(operation, signal) {
    const lockPath = await resolveSafeFile(root, 'state/write.lock', true)
    const token = randomUUID()
    const started = Date.now()
    let handle
    while (!handle) {
      abort(signal)
      try {
        handle = await fs.open(lockPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }))
        await handle.sync()
      } catch (error) {
        if (handle) { await handle.close(); await fs.unlink(lockPath); throw error }
        if (error.code !== 'EEXIST') throw error
        let owner
        try { owner = JSON.parse(await readSafeFile(root, 'state/write.lock', 2048)) } catch (readError) {
          if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError
        }
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (processError) {
            if (processError.code === 'ESRCH') throw manualError('LOCK_ORPHANED', '上次写入进程已退出。请确认没有写入任务后移走 state/write.lock 再重试；手册和历史仍保留。')
          }
        }
        if (Date.now() - started >= lockTimeoutMs) throw manualError('LOCK_TIMEOUT', '另一进程正在写入手册，请稍后重试。')
        await delay(25)
      }
    }
    try { abort(signal); return await operation() } finally {
      await handle.close()
      const current = JSON.parse(await readSafeFile(root, 'state/write.lock', 2048))
      if (current.token === token) await fs.unlink(lockPath)
    }
  }

  async function atomicWrite(relative, content) {
    const target = await resolveSafeFile(root, relative, true)
    const temporary = `${relative}.${randomUUID()}.tmp`
    const tempPath = await resolveSafeFile(root, temporary, true)
    try {
      const handle = await fs.open(tempPath, 'wx', 0o600)
      try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
      await resolveSafeFile(root, relative, true)
      // No unlink-before-rename fallback: a failed commit leaves the previous file intact.
      await rename(tempPath, target)
    } finally {
      try { await fs.unlink(tempPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }

  async function appendImmutable(relative, value) {
    const target = await resolveSafeFile(root, relative, true)
    let handle
    try { handle = await fs.open(target, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await readSafeFile(root, relative, maxDocumentBytes * 8)
      if (existing !== JSON.stringify(value)) throw manualError('HISTORY_CORRUPT', '历史记录已存在且内容不匹配。')
      return
    }
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  }

  async function load(id) {
    validId(id)
    try {
      const raw = await readSafeFile(root, `${id}.md`, maxDocumentBytes)
      return { raw, document: parseRaw(id, raw) }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }

  function checkRevision(current, expectedRevision) {
    if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !REVISION.test(expectedRevision))) throw manualError('INVALID_ARGUMENT', '必须提供上次读取的 expectedRevision；新建使用 null。')
    const actual = current?.document.revision ?? null
    if (actual !== expectedRevision) throw manualError('REVISION_CONFLICT', '章节已被其他编辑修改，请读取最新版本后合并。', { currentRevision: actual, expectedRevision })
  }

  async function snapshot(id, raw) {
    const revision = digest(raw)
    await appendImmutable(`history/${digest(id)}/snapshots/${revision}.json`, { id, revision, raw })
    return revision
  }

  async function commit(id, content, metadata, expectedRevision, operation, signal) {
    abort(signal)
    const current = await load(id)
    checkRevision(current, expectedRevision)
    const now = new Date().toISOString()
    const eventId = `${Date.now()}-${randomUUID()}`
    const raw = encodeRaw(id, content, { ...metadata, updatedAt: now, historyEventId: eventId })
    if (Buffer.byteLength(raw, 'utf8') > maxDocumentBytes) throw manualError('DOCUMENT_TOO_LARGE', '正文和元数据超过文档字节上限。')
    const revision = digest(raw)
    if (current) {
      await snapshot(id, current.raw)
      // A crash after rename but before the commit marker is recoverable from the
      // current Markdown's event pointer and its durable write-ahead record.
      if (current.raw.startsWith(HEADER)) {
        const headerEnd = current.raw.indexOf(' -->\n')
        let previousEvent
        try { previousEvent = JSON.parse(current.raw.slice(HEADER.length, headerEnd)).historyEventId } catch (error) {
          // An external editor may remove or invalidate the optional metadata header.
          if (!(error instanceof SyntaxError)) throw error
        }
        if (typeof previousEvent === 'string' && /^\d+-[a-f0-9-]{36}$/u.test(previousEvent)) {
          const previousBase = `history/${digest(id)}/events/${previousEvent}`
          try {
            const prepared = JSON.parse(await readSafeFile(root, `${previousBase}.prepare.json`, 8192))
            if (prepared.id === id && prepared.revision === current.document.revision) await appendImmutable(`${previousBase}.commit.json`, { revision: current.document.revision })
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
      }
    }
    await snapshot(id, raw)
    const eventBase = `history/${digest(id)}/events/${eventId}`
    const event = { id, revision, previousRevision: current?.document.revision ?? null, operation, author: metadata.author, reason: metadata.reason ?? '', recordedAt: now }
    await appendImmutable(`${eventBase}.prepare.json`, event)
    // External editors do not participate in the lock; recheck immediately before rename.
    checkRevision(await load(id), expectedRevision)
    abort(signal)
    await atomicWrite(`${id}.md`, raw)
    let historyPending = false
    try { await appendImmutable(`${eventBase}.commit.json`, { revision }) } catch { historyPending = true }
    return { ...parseRaw(id, raw), contentLength: content.length, totalLength: content.length, offset: 0, nextOffset: null, truncated: false, historyPending }
  }

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        await refreshSources()
        await ensurePlainDirectory(root, true)
        for (const directory of ['notes', 'generated', 'history', 'state']) await ensurePlainDirectory(path.join(root, directory), true)
        return withLock(async () => {
          let seedsCreated = 0
          if (options.seed !== false) for (const seed of MANUAL_SEEDS) {
            if (await load(seed.id)) continue
            await commit(seed.id, seed.content, { title: seed.title, module: 'dsh-manual', author: 'dsh-manual', status: 'reference', freshness: 'bundled', generatedContentHash: digest(seed.content) }, null, 'seed')
            seedsCreated++
          }
          return { initialized: true, seedsCreated }
        })
      })().catch((error) => { initialization = undefined; throw error })
    }
    return initialization
  }

  async function inventory(signal) {
    const ids = []
    let scanTruncated = false
    async function visit(relative, depth = 0) {
      if (depth > 4 || scanTruncated) return
      const directory = await ensurePlainDirectory(path.join(root, ...relative.split('/')))
      const handle = await fs.opendir(directory)
      try {
        for await (const entry of handle) {
          abort(signal)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) await visit(`${relative}/${entry.name}`, depth + 1)
          else if (entry.isFile() && entry.name.endsWith('.md')) {
            const id = `${relative}/${entry.name.slice(0, -3)}`
            try { validId(id) } catch { continue }
            if (ids.length >= maxDocuments) { scanTruncated = true; break }
            ids.push(id)
          }
          if (scanTruncated) break
        }
      } finally { try { await handle.close() } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error } }
    }
    await visit('generated'); await visit('notes')
    ids.sort()
    return { ids, scanTruncated }
  }

  async function freshness(document) {
    if (!document.source) return document
    const allowed = sources.find((source) => sourceId(source.path) === sourceId(document.source.path))
    const directory = allowed && sourceDirectory(allowed)
    if (!directory || !allowed) return { ...document, freshness: 'unavailable', freshnessReason: allowed ? 'source-root-unavailable' : 'source-not-configured' }
    try {
      const source = await collectSource(directory, allowed, maxDocumentBytes)
      const relocated = document.source.path !== allowed.path
      return { ...document, freshness: !relocated && source.hash === document.source.hash ? 'current' : 'stale', freshnessReason: relocated ? 'source-relocated' : source.hash === document.source.hash ? 'source-unchanged' : 'source-changed' }
    } catch (error) {
      return { ...document, freshness: error.code === 'ENOENT' ? 'stale' : 'unavailable', freshnessReason: error.code === 'ENOENT' ? 'source-missing' : 'source-unreadable' }
    }
  }

  async function list(args = {}) {
    await initialize()
    const offset = integer(args.offset, 0, 0, 1000000, 'offset')
    const limit = integer(args.limit, 50, 1, 100, 'limit')
    if (args.kind !== undefined && !['note', 'generated'].includes(args.kind)) throw manualError('INVALID_ARGUMENT', 'kind 应为 note 或 generated。')
    const query = shortText(args.query, '', 300).toLocaleLowerCase()
    const { ids, scanTruncated } = await inventory(args.signal)
    const documents = []
    const issues = []
    for (const id of ids) {
      abort(args.signal)
      let loaded
      try { loaded = await load(id) } catch (error) { issues.push(diagnostic(id, error)); continue }
      if (!loaded) continue
      const doc = loaded.document
      if ((!args.kind || args.kind === doc.kind) && (!query || `${doc.title} ${doc.id} ${doc.module}`.toLocaleLowerCase().includes(query))) documents.push(summary(await freshness(doc)))
    }
    return boundPage(documents, documents.length, offset, limit, maxResultBytes, scanTruncated, issues)
  }

  async function read(args = {}) {
    await initialize(); abort(args.signal)
    const loaded = await load(args.id)
    if (!loaded) throw manualError('NOT_FOUND', '没有找到该手册章节。')
    const doc = await freshness(loaded.document)
    const offset = integer(args.offset, 0, 0, maxDocumentBytes, 'offset')
    const limit = integer(args.limit, 12000, 1, maxDocumentBytes, 'limit')
    let end = Math.min(doc.content.length, offset + limit)
    const result = { ...doc, content: '', contentLength: doc.content.length, totalLength: doc.content.length, offset, nextOffset: null, truncated: false }
    const update = () => {
      if (end < doc.content.length && end > offset && /[\uDC00-\uDFFF]/u.test(doc.content[end])) end--
      result.content = doc.content.slice(offset, end)
      result.nextOffset = end < doc.content.length ? end : null
      result.truncated = offset > 0 || result.nextOffset !== null
    }
    update()
    while (byteSize(result) > maxResultBytes && end > offset) { end = offset + Math.floor((end - offset) * 0.8); update() }
    if (byteSize(result) > maxResultBytes || (end === offset && offset < doc.content.length)) throw manualError('RESULT_TOO_SMALL', '结果字节预算不足。')
    return result
  }

  async function search(args = {}) {
    await initialize()
    const query = shortText(args.query, '', 300).trim()
    if (!query) throw manualError('INVALID_ARGUMENT', '搜索词不能为空。')
    const terms = query.toLocaleLowerCase().split(/\s+/u)
    const offset = integer(args.offset, 0, 0, 1000000, 'offset')
    const limit = integer(args.limit, 20, 1, 100, 'limit')
    const { ids, scanTruncated } = await inventory(args.signal)
    const results = []
    const issues = []
    for (const id of ids) {
      abort(args.signal)
      let loaded
      try { loaded = await load(id) } catch (error) { issues.push(diagnostic(id, error)); continue }
      if (!loaded) continue
      const doc = loaded.document
      const haystack = `${doc.title}\n${doc.content}`.toLocaleLowerCase()
      if (!terms.every((term) => haystack.includes(term))) continue
      const position = Math.max(0, doc.content.toLocaleLowerCase().indexOf(terms[0]))
      results.push({ ...summary(await freshness(doc)), excerpt: doc.content.slice(Math.max(0, position - 80), position + 400), score: terms.reduce((value, term) => value + (doc.title.toLocaleLowerCase().includes(term) ? 3 : 1), 0) })
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return boundPage(results, results.length, offset, limit, maxResultBytes, scanTruncated, issues)
  }

  async function edit(args = {}) {
    await initialize()
    validId(args.id)
    if (!args.id.startsWith('notes/')) throw manualError('READ_ONLY', '自动章节由来源同步维护，请将补充内容写到 notes/。')
    if (typeof args.content !== 'string') throw manualError('INVALID_ARGUMENT', 'content 必须是 Markdown 文本。')
    return withLock(async () => {
      const current = await load(args.id)
      checkRevision(current, args.expectedRevision)
      return commit(args.id, args.content, {
        title: shortText(args.title, current?.document.title ?? args.id),
        author: shortText(args.author, 'model', 120), reason: shortText(args.reason, '', 500),
        module: current?.document.module ?? 'dsh', status: 'draft', freshness: 'unavailable',
      }, args.expectedRevision, 'edit', args.signal)
    }, args.signal)
  }

  async function history(args = {}) {
    await initialize(); validId(args.id)
    const offset = integer(args.offset, 0, 0, 1000000, 'offset')
    const limit = integer(args.limit, 20, 1, 100, 'limit')
    const directoryRelative = `history/${digest(args.id)}/events`
    let directory
    try { directory = await ensurePlainDirectory(path.join(root, ...directoryRelative.split('/'))) } catch (error) {
      if (error.code === 'ENOENT') return boundPage([], 0, offset, limit, maxResultBytes)
      throw error
    }
    const names = []
    let scanTruncated = false
    const handle = await fs.opendir(directory)
    for await (const entry of handle) {
      abort(args.signal)
      if (entry.isFile() && /^\d+-[a-f0-9-]+\.prepare\.json$/u.test(entry.name)) names.push(entry.name)
      if (names.length >= 10000) { scanTruncated = true; break }
    }
    names.sort().reverse()
    const current = await load(args.id)
    const items = []
    for (const name of names.slice(offset, offset + limit)) {
      const event = JSON.parse(await readSafeFile(root, `${directoryRelative}/${name}`, 8192))
      if (event.id !== args.id || !REVISION.test(event.revision ?? '')) throw manualError('HISTORY_CORRUPT', '历史记录格式无效。')
      let committed = false
      try {
        const marker = JSON.parse(await readSafeFile(root, `${directoryRelative}/${name.replace('.prepare.', '.commit.')}`, 2048))
        committed = marker.revision === event.revision
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      items.push({ ...event, committed: committed || current?.document.revision === event.revision, historyPending: !committed, current: current?.document.revision === event.revision })
    }
    // Already paginated the bounded disk records; do not offset twice.
    const page = boundPage(items, items.length, 0, limit, maxResultBytes, scanTruncated)
    return { ...page, total: names.length, offset, nextOffset: offset + page.items.length < names.length ? offset + page.items.length : null, truncated: page.truncated || offset + page.items.length < names.length }
  }

  async function restore(args = {}) {
    await initialize(); validId(args.id)
    if (!args.id.startsWith('notes/')) throw manualError('READ_ONLY', '自动章节应通过来源同步恢复。')
    if (!REVISION.test(args.revision ?? '')) throw manualError('INVALID_ARGUMENT', 'revision 必须为历史修订号。')
    return withLock(async () => {
      let record
      try { record = JSON.parse(await readSafeFile(root, `history/${digest(args.id)}/snapshots/${args.revision}.json`, maxDocumentBytes * 8)) } catch (error) {
        if (error.code === 'ENOENT') throw manualError('NOT_FOUND', '没有找到该历史修订。')
        throw error
      }
      if (record.id !== args.id || record.revision !== args.revision || typeof record.raw !== 'string' || digest(record.raw) !== args.revision) throw manualError('HISTORY_CORRUPT', '历史快照校验失败。')
      const old = parseRaw(args.id, record.raw)
      return commit(args.id, old.content, {
        title: old.title, module: old.module, author: shortText(args.author, 'model', 120),
        reason: shortText(args.reason, `restore:${args.revision}`, 500), status: 'draft', freshness: 'unavailable',
      }, args.expectedRevision, 'restore', args.signal)
    }, args.signal)
  }

  async function sync(args = {}) {
    await initialize()
    await refreshSources()
    return withLock(async () => {
      const report = { updated: [], unchanged: [], stale: [], conflicts: [], failed: [], configured: sources.length }
      if (options.sourceResolutionError) report.failed.push({ id: 'generated/source-context', source: 'project-root', code: diagnostic('source-context', options.sourceResolutionError).code, message: '来源上下文不可用；笔记保留，未猜测仓库或旧家园。' })
      if (discoveryIssue) report.failed.push(discoveryIssue)
      for (const spec of sources) {
        abort(args.signal)
        const id = sourceId(spec.path)
        try {
          const current = await load(id)
          if (current?.document.editedExternally) { report.conflicts.push({ id, source: spec.path, code: 'GENERATED_EDITED_EXTERNALLY' }); continue }
          let source
          try {
            const directory = sourceDirectory(spec)
            if (!directory) throw manualError('INVALID_SOURCE', '未配置来源根目录。')
            source = await collectSource(directory, spec, maxDocumentBytes)
          } catch (error) {
            if (error.code === 'ENOENT' && current) {
              if (current.document.freshness !== 'stale') await commit(id, current.document.content, {
                title: current.document.title, module: current.document.module, author: 'sync', status: 'reference', freshness: 'stale',
                source: current.document.source, generatedContentHash: digest(current.document.content), reason: 'source-missing',
              }, current.document.revision, 'sync-missing', args.signal)
              report.stale.push({ id, source: spec.path, reason: 'source-missing' }); continue
            }
            throw error
          }
          if (current?.document.source?.hash === source.hash && current.document.source.path === spec.path
            && (current.document.source.identityPath ?? sourceIdentity(current.document.source.path)) === (spec.identityPath ?? spec.path)
            && current.document.freshness === 'current') { report.unchanged.push(id); continue }
          await commit(id, source.content, {
            title: spec.title, module: spec.module, author: 'sync', status: 'reference', freshness: 'current',
            source: { path: spec.path, hash: source.hash, syncedAt: new Date().toISOString(), ...(spec.identityPath ? { identityPath: spec.identityPath } : {}), ...(source.version ? { version: source.version } : {}) },
            generatedContentHash: digest(source.content),
          }, current?.document.revision ?? null, 'sync', args.signal)
          report.updated.push(id)
        } catch (error) {
          if (error.code === 'ABORTED') throw error
          report.failed.push({ id, source: spec.path, code: error.code ?? 'SOURCE_ERROR', message: '该来源未完成同步；已保留既有章节，可修正来源后重试。' })
        }
      }
      return report
    }, args.signal)
  }

  return Object.freeze({ initialize, list, read, search, edit, history, restore, sync, limits: { maxDocumentBytes, maxResultBytes, maxDocuments } })
}
