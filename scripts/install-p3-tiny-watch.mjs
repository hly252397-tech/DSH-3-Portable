import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-p3-tiny-watch'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDir, '..')
const args = parseArgs(process.argv.slice(2))
const profileDir = resolve(args.profile ?? join(repositoryRoot, 'Data', 'DSH', 'profiles', 'web'))
const sourceDir = resolve(args.source ?? join(repositoryRoot, 'plugins', PACKAGE_NAME))
const targetDir = join(profileDir, 'local', PACKAGE_NAME)
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
const manifestPath = join(profileDir, 'package.json')

if (!existsSync(join(sourceDir, 'package.json')) || !existsSync(join(sourceDir, 'lib', 'index.js'))) {
  fail(`插件源码不完整：${sourceDir}`)
}
if (!existsSync(manifestPath)) fail(`找不到 DSH Web Profile：${manifestPath}`)

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const portableRoot = resolve(repositoryRoot)
const backupDir = resolve(args.backup ?? join(repositoryRoot, 'Data', 'Updates', `P3TinyWatch-backup-${stamp}`))
assertInside(portableRoot, profileDir, 'Profile')
assertInside(portableRoot, backupDir, '备份目录')

const beforeManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const nextManifest = structuredClone(beforeManifest)
nextManifest.dependencies = { ...(nextManifest.dependencies ?? {}), [PACKAGE_NAME]: `link:./local/${PACKAGE_NAME}` }
nextManifest.dsh = { ...(nextManifest.dsh ?? {}) }
nextManifest.dsh.profile = { ...(nextManifest.dsh.profile ?? {}) }
const bundles = Array.isArray(nextManifest.dsh.profile.bundles) ? [...nextManifest.dsh.profile.bundles] : []
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
nextManifest.dsh.profile.bundles = bundles

if (args.dryRun) {
  console.log(JSON.stringify({
    action: 'dry-run', sourceDir, profileDir, targetDir, linkPath, backupDir,
    dependencyChanged: beforeManifest.dependencies?.[PACKAGE_NAME] !== nextManifest.dependencies[PACKAGE_NAME],
    bundleAdded: !(beforeManifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME),
  }, null, 2))
  process.exit(0)
}

await mkdir(backupDir, { recursive: true })
await backupIfExists(manifestPath, join(backupDir, 'package.json'))
await backupIfExists(join(profileDir, 'pnpm-lock.yaml'), join(backupDir, 'pnpm-lock.yaml'))
await backupIfExists(join(profileDir, 'cordis.patch.yml'), join(backupDir, 'cordis.patch.yml'))
await backupIfExists(targetDir, join(backupDir, 'local', PACKAGE_NAME))

const staged = `${targetDir}.staged-${process.pid}`
await rm(staged, { recursive: true, force: true })
await mkdir(dirname(targetDir), { recursive: true })
await cp(sourceDir, staged, { recursive: true, force: true })
await validatePlugin(staged)
await rm(targetDir, { recursive: true, force: true })
await rename(staged, targetDir)
await atomicWrite(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)

await mkdir(dirname(linkPath), { recursive: true })
await removeExistingLinkOrDirectory(linkPath)
await symlink(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

const linkTarget = await readlink(linkPath).catch(() => undefined)
await validatePlugin(targetDir)
const installedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (installedManifest.dependencies?.[PACKAGE_NAME] !== `link:./local/${PACKAGE_NAME}`) fail('Profile dependency 未正确写入。')
if (!(installedManifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME)) fail('Profile bundles 未正确写入。')
if (!linkTarget) fail('node_modules Junction/目录链接创建失败。')

const result = {
  action: 'installed',
  package: PACKAGE_NAME,
  version: JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')).version,
  sourceDir,
  profileDir,
  targetDir,
  linkPath,
  linkTarget,
  backupDir,
  manifestUpdated: true,
  lockfileUpdated: false,
  note: '为避免触发 Profile 插件矩阵整体升级，安装器不执行 pnpm；已直接建立 link 语义的目录链接。',
}
await writeFile(join(backupDir, 'install-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))

async function validatePlugin(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  if (manifest.name !== PACKAGE_NAME) fail(`插件包名不匹配：${manifest.name}`)
  const entry = resolve(dir, manifest.main ?? 'lib/index.js')
  assertInside(dir, entry, '插件入口')
  if (!existsSync(entry)) fail(`插件入口不存在：${entry}`)
  if (!existsSync(join(dir, 'cordis.patch.yml'))) fail(`缺少 cordis.patch.yml：${dir}`)
}

async function backupIfExists(source, destination) {
  if (!existsSync(source)) return
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
}

async function removeExistingLinkOrDirectory(path) {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) await rm(path, { force: true })
    else await rm(path, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }); throw error }
}

function assertInside(parent, child, label) {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  fail(`${label} 超出便携版根目录：${child}`)
}

function parseArgs(values) {
  const result = { dryRun: false }
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value === '--dry-run') result.dryRun = true
    else if (value === '--profile') result.profile = values[++i]
    else if (value === '--source') result.source = values[++i]
    else if (value === '--backup') result.backup = values[++i]
    else fail(`未知参数：${value}`)
  }
  return result
}

function fail(message) {
  console.error(`[P3 Tiny Watch Installer] ${message}`)
  process.exit(1)
}
