import { stageLocalDesktopBuild } from '../src/portable-desktop-update.js'
import { preparePackagedRuntimeCacheInChild } from '../src/extract-runtime.js'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'
import { dirname, join, resolve } from 'node:path'

const [portableRoot, appDirectory, version, replaceOption] = process.argv.slice(2)
if (portableRoot === undefined || appDirectory === undefined || version === undefined) {
  throw new Error('用法：stage-local-desktop-candidate <portableRoot> <appDirectory> <version> [--replace-pending]')
}

const root = resolve(portableRoot)
const app = resolve(appDirectory)
const resourcesDir = join(app, 'resources')
const legacyRuntimeDir = join(root, 'Data', 'Runtime', 'dsh-runtime')
const activeRuntimeDir = resolveActiveRuntimeDir(legacyRuntimeDir)
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
})
process.stdout.write(`${JSON.stringify(staged, undefined, 2)}\n`)
