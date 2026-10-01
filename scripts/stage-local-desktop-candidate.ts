import { stageLocalDesktopBuild } from '../src/portable-desktop-update.js'
import { preparePackagedRuntimeCacheInChild } from '../src/extract-runtime.js'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { assertCustomizationPreserved, captureCustomizationState, checkPreservationManifest, readPreservationManifest } from '../src/customization-preservation.js'
import { resolveActivePortablePaths } from '../src/portable-paths.js'

const [portableRoot, appDirectory, version, replaceOption] = process.argv.slice(2)
if (portableRoot === undefined || appDirectory === undefined || version === undefined) {
  throw new Error('用法：stage-local-desktop-candidate <portableRoot> <appDirectory> <version> [--replace-pending]')
}

const root = resolve(portableRoot)
const app = resolve(appDirectory)
// The build wrapper owns post-stage validation/finalization. Direct CLI use must
// not publish a legacy unguarded local candidate that can bypass this receipt.
const receiptIntentRaw = process.env.DSH_BUILD_RECEIPT_INTENT
if (!receiptIntentRaw) throw new Error('本地构建暂存必须经 build-input-receipt.mjs；缺少构建输入 intent。')
const buildReceiptIntent = JSON.parse(receiptIntentRaw) as { inputFingerprint?: unknown; coreFingerprint?: unknown; asarSha256?: unknown }
if (![buildReceiptIntent.inputFingerprint, buildReceiptIntent.coreFingerprint, buildReceiptIntent.asarSha256]
  .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
  throw new Error('本地构建输入 intent 无效。')
}
const resourcesDir = join(app, 'resources')
const legacyRuntimeDir = join(root, 'Data', 'Runtime', 'dsh-runtime')
const activeRuntimeDir = resolveActiveRuntimeDir(legacyRuntimeDir)
const manifest = readPreservationManifest(root)
const candidateManifest = JSON.parse(readFileSync(join(resourcesDir, 'preservation.json'), 'utf8')) as unknown
const preservation = checkPreservationManifest(candidateManifest, manifest)
if (!preservation.ok) throw new Error(preservation.issues.map(item => item.code + ': ' + item.detail).join('\n'))
const profileDir = join(resolveActivePortablePaths(root)!.dshHome, 'profiles', 'web')
const customizationSnapshot = captureCustomizationState({ portableRoot: root, profileDir, manifest })
process.stdout.write('正在后台准备候选共享环境；当前桌面可继续使用，重启阶段不再解压。\n')
const preparation = await preparePackagedRuntimeCacheInChild({
  resourcesDir,
  runtimeRoot: dirname(legacyRuntimeDir),
  nodeExecutable: join(resourcesDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  scriptPath: join(resourcesDir, 'extract-runtime.mjs'),
  skipOfficial: activeRuntimeDir !== resolve(legacyRuntimeDir),
  onProgress: progress => process.stdout.write(`候选共享环境：${progress.phase}/${progress.state}\n`),
})
process.stdout.write(preparation.prepared ? '候选共享环境后台准备完成。\n' : '候选共享环境命中现有内容缓存。\n')
const staged = await stageLocalDesktopBuild({
  portableRoot: root,
  appDirectory: app,
  version,
  replacePending: replaceOption === '--replace-pending',
  customizationSnapshot,
  buildReceiptIntent: buildReceiptIntent as { inputFingerprint: string; coreFingerprint: string; asarSha256: string },
  verifyCandidatePreservation: async directory => {
    const candidate = JSON.parse(readFileSync(join(directory, 'resources', 'preservation.json'), 'utf8')) as unknown
    const checked = checkPreservationManifest(candidate, manifest)
    if (!checked.ok) throw new Error(checked.issues.map(item => item.code + ': ' + item.detail).join('\n'))
    assertCustomizationPreserved(customizationSnapshot, { portableRoot: root, profileDir, manifest })
  },
})
process.stdout.write(`${JSON.stringify(staged, undefined, 2)}\n`)
