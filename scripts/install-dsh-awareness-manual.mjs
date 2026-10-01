import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { activeUiProfile } from './lib/active-ui-profile.mjs'

export const PACKAGES = Object.freeze(['dsh-system-awareness', 'dsh-manual'])
const OWNER = 'dsh-awareness-manual-installer-v1'
const MARKER = '.dsh-awareness-install.json'
const repositoryDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const digest = value => createHash('sha256').update(value).digest('hex')
const spec = name => `link:./local/${name}`

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function inside(root, path, label) {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('UNSAFE_PATH', `${label} 超出指定根目录：${path}`)
}

async function statOptional(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function noLinkedParents(root, path) {
  inside(root, path, '路径')
  let cursor = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    const stat = await statOptional(cursor)
    if (stat?.isSymbolicLink()) fail('UNSAFE_PATH', `目录链包含链接：${cursor}`)
    if (stat && !stat.isDirectory()) fail('UNSAFE_PATH', `目录链包含非目录：${cursor}`)
  }
}

function parseManifest(raw) {
  const manifest = JSON.parse(raw)
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') fail('INVALID_MANIFEST', 'Profile 清单必须为对象。')
  for (const value of [manifest.dependencies, manifest.dsh, manifest.dsh?.profile]) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) fail('INVALID_MANIFEST', 'Profile 字段结构不合法。')
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string'))) fail('INVALID_MANIFEST', 'bundles 必须为字符串数组。')
  return manifest
}

export function addManifestEntries(manifest) {
  const next = structuredClone(manifest)
  next.dependencies ??= {}
  next.dsh ??= {}
  next.dsh.profile ??= {}
  next.dsh.profile.bundles ??= []
  for (const name of PACKAGES) {
    next.dependencies[name] = spec(name)
    if (!next.dsh.profile.bundles.includes(name)) next.dsh.profile.bundles.push(name)
  }
  return next
}

export function revertManifestEntries(current, before) {
  const next = structuredClone(current)
  for (const name of PACKAGES) {
    if (next.dependencies?.[name] !== spec(name)) fail('ROLLBACK_CONFLICT', `${name} 的依赖已被其他操作修改；不覆盖。`)
    if (!next.dsh?.profile?.bundles?.includes(name)) fail('ROLLBACK_CONFLICT', `${name} 的启用状态已被其他操作修改；不覆盖。`)
    if (Object.hasOwn(before.dependencies ?? {}, name)) next.dependencies[name] = before.dependencies[name]
    else delete next.dependencies[name]
    if (!(before.dsh?.profile?.bundles ?? []).includes(name)) next.dsh.profile.bundles = next.dsh.profile.bundles.filter(value => value !== name)
  }
  // Only remove containers introduced by this transaction and still empty.
  if (!before.dependencies && !Object.keys(next.dependencies).length) delete next.dependencies
  if (!before.dsh?.profile?.bundles && !next.dsh.profile.bundles.length) delete next.dsh.profile.bundles
  if (!before.dsh?.profile && !Object.keys(next.dsh.profile).length) delete next.dsh.profile
  if (!before.dsh && !Object.keys(next.dsh).length) delete next.dsh
  return next
}

async function treeFiles(root) {
  const files = []
  async function walk(dir, depth) {
    if (depth > 16) fail('INVALID_PACKAGE', '插件目录层级超出限制。')
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH', `插件含链接，拒绝复制/替换：${path}`)
      if (stat.isDirectory()) await walk(path, depth + 1)
      else if (stat.isFile()) {
        if (stat.size > 16 * 1024 * 1024 || files.length >= 4096) fail('INVALID_PACKAGE', '插件制品超出安装器的大小限制。')
        files.push(path)
      } else fail('INVALID_PACKAGE', `插件包含特殊文件：${path}`)
    }
  }
  await walk(root, 0)
  return files
}

async function treeDigest(root) {
  const hash = createHash('sha256')
  for (const file of await treeFiles(root)) hash.update(relative(root, file).split(sep).join('/')).update('\0').update(digest(await readFile(file))).update('\0')
  return hash.digest('hex')
}

async function validatePackage(root, name) {
  if (!(await statOptional(root))?.isDirectory()) fail('INVALID_PACKAGE', `插件源码不存在：${root}`)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== name || manifest.type !== 'module') fail('INVALID_PACKAGE', `插件名称或模块类型不匹配：${name}`)
  for (const entry of [manifest.main ?? 'lib/index.js', manifest.dsh?.bundle?.patch]) {
    if (typeof entry !== 'string') fail('INVALID_PACKAGE', `${name} 缺少 bundle patch。`)
    const file = resolve(root, entry)
    inside(root, file, '插件入口')
    if (!(await statOptional(file))?.isFile()) fail('INVALID_PACKAGE', `插件入口缺失：${file}`)
  }
  return { version: manifest.version, sha256: await treeDigest(root) }
}

async function checkLink(path, target) {
  const stat = await statOptional(path)
  if (!stat) return false
  if (!stat.isSymbolicLink()) fail('FOREIGN_DEPLOYMENT', `node_modules 位置不是本地插件链接：${path}`)
  const linked = resolve(dirname(path), await readlink(path))
  if (linked.toLowerCase() !== target.toLowerCase() || (await realpath(path)).toLowerCase() !== (await realpath(target)).toLowerCase()) {
    fail('FOREIGN_DEPLOYMENT', `链接并非指向本次 local 插件：${path}`)
  }
  return true
}

async function optionsPaths(options = {}) {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot ?? repositoryDefault))
  // Explicit --profile selects a target, not permission to write during an
  // unfinished runtime/home transaction in this same portable repository.
  const active = activeUiProfile(repositoryRoot)
  const profileDir = resolve(options.profileDir ?? active.profile)
  const sourceRoot = resolve(options.sourceRoot ?? join(repositoryRoot, 'plugins'))
  inside(repositoryRoot, profileDir, 'Profile')
  inside(repositoryRoot, sourceRoot, '插件源码')
  await noLinkedParents(repositoryRoot, profileDir)
  await noLinkedParents(repositoryRoot, sourceRoot)
  await noLinkedParents(repositoryRoot, join(profileDir, 'local'))
  await noLinkedParents(repositoryRoot, join(profileDir, 'node_modules'))
  const manifestPath = join(profileDir, 'package.json')
  if (!(await statOptional(manifestPath))?.isFile()) fail('INVALID_MANIFEST', 'Profile package.json 缺失或不是普通文件。')
  return { repositoryRoot, profileDir, sourceRoot, manifestPath }
}

export async function planInstall(options = {}) {
  const paths = await optionsPaths(options)
  const raw = await readFile(paths.manifestPath, 'utf8')
  const before = parseManifest(raw)
  const packages = []
  for (const name of PACKAGES) {
    const source = join(paths.sourceRoot, name)
    await noLinkedParents(paths.repositoryRoot, source)
    const validated = await validatePackage(source, name)
    const target = join(paths.profileDir, 'local', name)
    const link = join(paths.profileDir, 'node_modules', name)
    const existing = await statOptional(target)
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) fail('FOREIGN_DEPLOYMENT', `拒绝替换非真实目录：${target}`)
      let marker
      try { marker = JSON.parse(await readFile(join(target, MARKER), 'utf8')) } catch (error) {
        fail('FOREIGN_DEPLOYMENT', `同名插件不属于本安装器，未覆盖：${target} (${error.code ?? 'invalid marker'})`)
      }
      if (marker.owner !== OWNER || marker.name !== name) fail('FOREIGN_DEPLOYMENT', `同名插件不属于本安装器：${target}`)
      await validatePackage(target, name)
    }
    const linked = await checkLink(link, target)
    if (!existing && (Object.hasOwn(before.dependencies ?? {}, name) || (before.dsh?.profile?.bundles ?? []).includes(name))) {
      fail('FOREIGN_DEPLOYMENT', `已有 ${name} 清单记录但没有本安装器部署；先人工核对。`)
    }
    packages.push({ name, source, target, link, version: validated.version, sourceSha256: validated.sha256, previousSha256: existing ? await treeDigest(target) : null, previousLink: linked })
  }
  return { action: 'dry-run', ...paths, manifestSha256: digest(raw), packages, activation: 'not-performed', note: '仅部署插件制品和 Profile 增量；不安装依赖、不升级运行时、不重启或请求重载。' }
}

async function atomicWrite(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
  try {
    let lastError
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rename(temp, path)
        return
      } catch (error) {
        lastError = error
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || attempt === 7) throw error
        await delay(25 * (attempt + 1))
      }
    }
    throw lastError
  } finally {
    await unlink(temp).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup })
  }
}

/** Optimistic CAS, serialized for this installer by withLock. Uncooperative editors
 * must remain quiescent during the final comparison/rename window. */
export async function commitManifestCas(path, expectedSha256, next) {
  const content = json(next)
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
  try {
    if (digest(await readFile(path)) !== expectedSha256) fail('MANIFEST_CONFLICT', 'Profile 清单已被另一个操作修改；本次写入已取消。')
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return digest(content)
}

async function withLock(profileDir, action) {
  // Same wx sibling lock as @deepseek-ai/dsh-atomic-write / PluginManager.
  // This serializes our transaction with official profile package operations.
  const lockPath = join(profileDir, 'package.json.lock')
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST' || (error.code === 'EPERM' && await statOptional(lockPath))) fail('INSTALL_BUSY', '已有 Profile 写入操作或遗留锁；请检查锁内事务信息，禁止自动抢锁。')
    throw error
  }
  const token = randomUUID()
  try {
    await handle.writeFile(json({ owner: OWNER, token, pid: process.pid, createdAt: new Date().toISOString() }))
    return await action()
  } finally {
    await handle.close()
    const lock = await statOptional(lockPath)
    if (lock?.isFile() && !lock.isSymbolicLink()) {
      const content = JSON.parse(await readFile(lockPath, 'utf8'))
      if (content.token === token) await unlink(lockPath)
    }
  }
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true })
  for (const path of await treeFiles(source)) {
    const dest = join(target, relative(source, path))
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(path, dest)
  }
}

export async function install(options = {}) {
  const initial = await planInstall(options)
  if (options.expectedManifestSha256 && options.expectedManifestSha256 !== initial.manifestSha256) fail('MANIFEST_CONFLICT', '预检后 Profile 清单已变化，请重新核对。')
  return withLock(initial.profileDir, async () => {
    const plan = await planInstall(options)
    if (plan.manifestSha256 !== initial.manifestSha256) fail('MANIFEST_CONFLICT', '获取安装锁期间 Profile 清单变化。')
    const raw = await readFile(plan.manifestPath, 'utf8')
    if (digest(raw) !== plan.manifestSha256) fail('MANIFEST_CONFLICT', '准备事务期间 Profile 清单变化。')
    const before = parseManifest(raw)
    const transactionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    const backupBase = join(plan.repositoryRoot, 'Data', 'Updates', 'DSHAwarenessManual')
    await noLinkedParents(plan.repositoryRoot, backupBase)
    const transactionDir = join(backupBase, transactionId)
    await mkdir(transactionDir, { recursive: true })
    const receiptPath = join(transactionDir, 'receipt.json')
    const receipt = {
      schema: 1, owner: OWNER, transactionId, status: 'preparing', createdAt: new Date().toISOString(),
      profile: relative(plan.repositoryRoot, plan.profileDir), manifestBeforeSha256: plan.manifestSha256,
      manifestCommitted: false, packages: [], activation: 'not-performed',
    }
    const save = () => atomicWrite(receiptPath, json(receipt))
    await writeFile(join(transactionDir, 'package.before.json'), raw, { flag: 'wx', mode: 0o600 })
    await save()
    try {
      for (const item of plan.packages) {
        const staged = join(transactionDir, 'staged', item.name)
        await copyTree(item.source, staged)
        const validated = await validatePackage(staged, item.name)
        if (validated.sha256 !== item.sourceSha256) fail('SOURCE_CONFLICT', `复制期间源码变化：${item.name}`)
        await writeFile(join(staged, MARKER), json({ owner: OWNER, name: item.name, transactionId }), { flag: 'wx' })
        receipt.packages.push({ name: item.name, previousSha256: item.previousSha256, previousLink: item.previousLink, installedSha256: await treeDigest(staged), previousMoved: false, installedMoved: false, linkCreated: false })
      }
      receipt.status = 'staged'
      await save()
      if (digest(await readFile(plan.manifestPath)) !== plan.manifestSha256) fail('MANIFEST_CONFLICT', '复制期间 Profile 清单变化。')
      await mkdir(join(plan.profileDir, 'local'), { recursive: true })
      await mkdir(join(plan.profileDir, 'node_modules'), { recursive: true })
      for (const item of receipt.packages) {
        const target = join(plan.profileDir, 'local', item.name)
        const link = join(plan.profileDir, 'node_modules', item.name)
        if (item.previousSha256) {
          if (await treeDigest(target) !== item.previousSha256) fail('DEPLOYMENT_CONFLICT', `现有插件已被修改：${item.name}`)
          await mkdir(join(transactionDir, 'previous'), { recursive: true })
          await rename(target, join(transactionDir, 'previous', item.name))
          item.previousMoved = true
          await save()
        } else if (await statOptional(target)) fail('DEPLOYMENT_CONFLICT', `同名部署已被其他操作创建：${item.name}`)
        await rename(join(transactionDir, 'staged', item.name), target)
        item.installedMoved = true
        await save()
        if (item.previousLink) await checkLink(link, target)
        else {
          if (await statOptional(link)) fail('DEPLOYMENT_CONFLICT', `同名链接已被创建：${item.name}`)
          await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
          item.linkCreated = true
          await save()
        }
      }
      receipt.manifestAfterSha256 = await commitManifestCas(plan.manifestPath, plan.manifestSha256, addManifestEntries(before))
      receipt.manifestCommitted = true
      receipt.status = 'installed'
      await save()
      return { action: 'installed', receiptPath, transactionDir, profileDir: plan.profileDir, packages: PACKAGES, activation: 'not-performed', manualDataChanged: false, note: plan.note }
    } catch (error) {
      receipt.status = 'failed'
      receipt.failure = { code: error.code ?? 'INSTALL_FAILED', message: error.message }
      await save()
      try {
        if (receipt.manifestCommitted) {
          const current = await readFile(plan.manifestPath, 'utf8')
          await commitManifestCas(plan.manifestPath, digest(current), revertManifestEntries(parseManifest(current), before))
          receipt.manifestCommitted = false
        }
        await restorePackages(plan.repositoryRoot, plan.profileDir, transactionDir, receipt, save)
        receipt.status = 'failed-restored'
        await save()
      } catch (restoreError) {
        receipt.recoveryFailure = { code: restoreError.code ?? 'RECOVERY_FAILED', message: restoreError.message }
        await save()
      }
      throw Object.assign(error, { receiptPath })
    }
  })
}

async function restorePackages(repositoryRoot, profileDir, transactionDir, receipt, save) {
  await noLinkedParents(repositoryRoot, join(profileDir, 'local'))
  await noLinkedParents(repositoryRoot, join(profileDir, 'node_modules'))
  for (const item of [...receipt.packages].reverse()) {
    const target = join(profileDir, 'local', item.name)
    const link = join(profileDir, 'node_modules', item.name)
    if (item.installedMoved) {
      if (await treeDigest(target) !== item.installedSha256) fail('ROLLBACK_CONFLICT', `插件安装后被修改；保留现状：${item.name}`)
      if (item.linkCreated) {
        await checkLink(link, target)
        await unlink(link)
        item.linkCreated = false
        await save()
      } else if (item.previousLink) await checkLink(link, target)
      await mkdir(join(transactionDir, 'rolled-back'), { recursive: true })
      await rename(target, join(transactionDir, 'rolled-back', item.name))
      item.installedMoved = false
      await save()
    }
    if (item.previousMoved) {
      const previous = join(transactionDir, 'previous', item.name)
      if (await treeDigest(previous) !== item.previousSha256) fail('ROLLBACK_CONFLICT', `旧部署备份被修改：${item.name}`)
      if (await statOptional(target)) fail('ROLLBACK_CONFLICT', `恢复目标已存在：${item.name}`)
      await rename(previous, target)
      item.previousMoved = false
      await save()
    }
  }
}

export async function rollback(options = {}) {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot ?? repositoryDefault))
  const receiptPath = resolve(options.receiptPath ?? '')
  const transactionDir = dirname(receiptPath)
  inside(join(repositoryRoot, 'Data', 'Updates', 'DSHAwarenessManual'), transactionDir, '事务')
  await noLinkedParents(repositoryRoot, transactionDir)
  if ((await lstat(receiptPath)).isSymbolicLink()) fail('UNSAFE_PATH', 'receipt 不得是链接。')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.owner !== OWNER || receipt.schema !== 1 || receipt.status !== 'installed' || !receipt.manifestCommitted
    || !Array.isArray(receipt.packages) || receipt.packages.length !== PACKAGES.length
    || receipt.packages.some((item, index) => item.name !== PACKAGES[index])) fail('INVALID_RECEIPT', '仅接受本安装器已完成的两插件事务。')
  const profileDir = resolve(repositoryRoot, receipt.profile)
  await noLinkedParents(repositoryRoot, profileDir)
  return withLock(profileDir, async () => {
    const before = parseManifest(await readFile(join(transactionDir, 'package.before.json'), 'utf8'))
    const manifestPath = join(profileDir, 'package.json')
    if (!(await lstat(manifestPath)).isFile()) fail('UNSAFE_PATH', 'Profile manifest 不是普通文件。')
    const current = await readFile(manifestPath, 'utf8')
    const next = revertManifestEntries(parseManifest(current), before)
    // Check the whole rollback before changing anything, including the original backups.
    for (const item of receipt.packages) {
      const target = join(profileDir, 'local', item.name)
      await noLinkedParents(repositoryRoot, target)
      if (await treeDigest(target) !== item.installedSha256) fail('ROLLBACK_CONFLICT', `安装后插件已被修改：${item.name}`)
      if (!await checkLink(join(profileDir, 'node_modules', item.name), target)) fail('ROLLBACK_CONFLICT', `安装链接已被其他操作移除：${item.name}`)
      if (item.previousMoved && await treeDigest(join(transactionDir, 'previous', item.name)) !== item.previousSha256) fail('ROLLBACK_CONFLICT', `旧部署备份变化：${item.name}`)
    }
    if (options.dryRun) return { action: 'rollback-dry-run', receiptPath, profileDir, packages: PACKAGES, activation: 'not-performed' }
    const save = () => atomicWrite(receiptPath, json(receipt))
    await commitManifestCas(manifestPath, digest(current), next)
    receipt.manifestCommitted = false
    receipt.status = 'rolling-back'
    await save()
    try {
      await restorePackages(repositoryRoot, profileDir, transactionDir, receipt, save)
      receipt.status = 'rolled-back'
      receipt.rolledBackAt = new Date().toISOString()
      await save()
    } catch (error) {
      receipt.status = 'rollback-needs-recovery'
      receipt.recoveryFailure = { code: error.code ?? 'RECOVERY_FAILED', message: error.message }
      await save()
      throw Object.assign(error, { receiptPath })
    }
    return { action: 'rolled-back', receiptPath, profileDir, packages: PACKAGES, activation: 'not-performed', manualDataChanged: false, note: '只撤销本事务字段；新部署移入 rolled-back，旧部署已恢复，手册知识和其他会话改动保留。' }
  })
}

function parseArgs(args) {
  const options = {}
  let action = 'dry-run'
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--install') action = 'install'
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--rollback') { action = 'rollback'; options.receiptPath = args[++i] }
    else if (arg === '--root') options.repositoryRoot = args[++i]
    else if (arg === '--profile') options.profileDir = args[++i]
    else if (arg === '--source') options.sourceRoot = args[++i]
    else if (arg === '--expect-manifest') options.expectedManifestSha256 = args[++i]
    else fail('INVALID_ARGUMENT', `未知参数：${arg}`)
    if (['--rollback', '--root', '--profile', '--source', '--expect-manifest'].includes(arg) && (!args[i] || args[i].startsWith('--'))) fail('INVALID_ARGUMENT', `${arg} 缺少参数。`)
  }
  if (options.dryRun && action === 'install') action = 'dry-run'
  return { action, options }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { action, options } = parseArgs(process.argv.slice(2))
    const result = action === 'install' ? await install(options) : action === 'rollback' ? await rollback(options) : await planInstall(options)
    console.log(json(result))
  } catch (error) {
    console.error(json({ action: 'failed', code: error.code ?? 'INSTALL_FAILED', message: error.message, receiptPath: error.receiptPath }))
    process.exitCode = 1
  }
}
