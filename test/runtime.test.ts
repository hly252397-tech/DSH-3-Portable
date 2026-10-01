import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OFFICIAL_LAUNCH_PEERS } from '../src/bundled-plugins.js'
import { resolveDshRuntime, resolveNodeExecutable } from '../src/runtime.js'
import { writeFileSha256 } from '../src/runtime-archive.js'

async function writeOfficialEntry(dir: string): Promise<void> {
  await mkdir(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
}

async function writeLaunchPeer(dir: string): Promise<void> {
  for (const peer of OFFICIAL_LAUNCH_PEERS) {
    const peerDir = join(dir, 'node_modules', ...peer.packageName.split('/'))
    await mkdir(peerDir, { recursive: true })
    await writeFile(join(peerDir, 'package.json'), '{}', 'utf8')
  }
}

test('官方运行时优先使用桌面独立目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-pick-'))
  try {
    const profile = join(root, 'profile')
    const desktop = join(root, 'desktop')
    await writeOfficialEntry(profile)
    await writeOfficialEntry(desktop)
    await writeLaunchPeer(desktop)
    const runtime = resolveDshRuntime({
      appPath: root,
      isPackaged: true,
      resourcesPath: join(root, 'resources'),
      profileDir: profile,
      desktopRuntimeDir: desktop,
    })
    assert.equal(runtime.root, desktop)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('桌面运行时可用时不使用 profile 里的官方包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-profile-'))
  try {
    const profile = join(root, 'profile')
    const desktop = join(root, 'desktop')
    await writeOfficialEntry(profile)
    await writeLaunchPeer(profile)
    await writeOfficialEntry(desktop)
    await writeLaunchPeer(desktop)
    const runtime = resolveDshRuntime({
      appPath: root,
      isPackaged: true,
      resourcesPath: join(root, 'resources'),
      profileDir: profile,
      desktopRuntimeDir: desktop,
    })
    assert.equal(runtime.root, desktop)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('打包态启动前校验随包 Node 的 SHA256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-node-hash-'))
  try {
    const nodeDir = join(root, 'node')
    const executable = join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
    await mkdir(nodeDir)
    await writeFile(executable, 'node', 'utf8')
    writeFileSha256(executable)
    assert.equal(resolveNodeExecutable({ isPackaged: true, resourcesPath: root }), executable)
    await writeFile(executable, 'tampered', 'utf8')
    assert.throws(() => resolveNodeExecutable({ isPackaged: true, resourcesPath: root }), /SHA256/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('旁置哈希自洽但与本次构建清单不符时拒绝启动（错版检测）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-node-manifest-'))
  try {
    const nodeDir = join(root, 'node')
    const executable = join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
    await mkdir(nodeDir, { recursive: true })
    await writeFile(executable, 'stale-node-binary', 'utf8')
    // 旁置哈希由同一二进制生成 ⇒ 它只能发现损坏，发现不了"错版"。
    writeFileSha256(executable)

    const manifestPath = join(root, 'app', 'package.json')
    const target = `${process.platform}-${process.arch}`
    await mkdir(join(root, 'app'), { recursive: true })

    // 1) 清单声明另一个哈希（模拟"该文件与所在构建不是同一批产物"）⇒ 必须拒绝。
    await writeFile(manifestPath, JSON.stringify({ config: { bundledNodeSha256: { [target]: 'a'.repeat(64) } } }), 'utf8')
    assert.throws(
      () => resolveNodeExecutable({ isPackaged: true, resourcesPath: root }),
      /清单不一致/,
    )

    // 2) 清单与该文件一致 ⇒ 放行。
    const actual = createHash('sha256').update(await readFile(executable)).digest('hex')
    await writeFile(manifestPath, JSON.stringify({ config: { bundledNodeSha256: { [target]: actual } } }), 'utf8')
    assert.equal(resolveNodeExecutable({ isPackaged: true, resourcesPath: root }), executable)

    // 3) 清单不可得（布局陌生）⇒ 不因为"读不到清单"而阻断启动。
    await rm(join(root, 'app'), { recursive: true, force: true })
    assert.equal(resolveNodeExecutable({ isPackaged: true, resourcesPath: root }), executable)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
