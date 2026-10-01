import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureBuildInputs, commitUIBuildReceipt, readBuildSnapshot, readCompiledSnapshot, stageBuildWithReceipt, verifyUIBuildReceipt, writeBuildSnapshot, writeCompiledSnapshot } from './lib/build-input-receipt.mjs'

const [operation, rootArg, appOrSnapshot, snapshotArg, version, mode] = process.argv.slice(2)
const root = resolve(rootArg ?? '.')
try {
  if (operation === 'capture') {
    if (!appOrSnapshot) throw new Error('capture requires a cache snapshot path')
    await writeBuildSnapshot(root, appOrSnapshot, await captureBuildInputs(root))
    console.log('PASS build input capture')
  } else if (operation === 'verify-ui') {
    await verifyUIBuildReceipt(root, appOrSnapshot)
    console.log('PASS ASAR/source receipt; only replaceable UI assets may differ')
  } else if (operation === 'pin-compiled') {
    await writeCompiledSnapshot(root, appOrSnapshot, await readBuildSnapshot(root, appOrSnapshot))
    console.log('PASS post-tsc compiled inputs sealed before tests')
  } else if (operation === 'commit-ui') {
    await commitUIBuildReceipt(root, await readBuildSnapshot(root, snapshotArg), appOrSnapshot)
    console.log('PASS copied UI assets and unchanged build inputs; receipt committed')
  } else if (operation === 'stage') {
    const snapshot = await readBuildSnapshot(root, snapshotArg)
    const staged = await stageBuildWithReceipt({ root, appDirectory: appOrSnapshot, snapshot, version, mode,
      ...(mode === 'full' ? { compiledSnapshot: await readCompiledSnapshot(root, snapshotArg) } : {}),
      stage: intent => new Promise((accept, reject) => {
        const child = spawn(process.execPath, [join(root, 'dist/scripts/stage-local-desktop-candidate.js'), root, appOrSnapshot, version, '--replace-pending'], {
          windowsHide: true, env: { ...process.env, DSH_BUILD_RECEIPT_INTENT: JSON.stringify(intent) }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        child.stdout.on('data', chunk => { output += String(chunk); process.stdout.write(chunk) })
        child.stderr.on('data', chunk => process.stderr.write(chunk))
        child.once('error', reject)
        child.once('close', code => {
          if (code !== 0) return reject(new Error(`Candidate stage failed (${code})`))
          try {
            const start = output.lastIndexOf('\n{')
            accept(JSON.parse(output.slice(start >= 0 ? start + 1 : 0)))
          } catch { reject(new Error('Candidate stage did not return an owned transaction')) }
        })
      }),
    })
    console.log(`PASS exact local transaction finalized: ${staged.transactionId}`)
    // The previous pending is protected until finalization. Afterwards reuse
    // the existing locked GC; a cleanup failure is not a failed validation and
    // must never withdraw the now-finalized candidate or delete evidence.
    try {
      const { prunePortableDesktopSlots } = await import(pathToFileURL(join(root, 'dist/src/portable-desktop-update.js')).href)
      await prunePortableDesktopSlots({ portableRoot: root })
    } catch {
      console.warn('候选已完成校验；历史槽清理未完成，已保留文件供后续正常维护。')
    }
  } else throw new Error('Expected capture, pin-compiled, verify-ui, commit-ui or stage')
} catch (failure) {
  console.error(failure instanceof Error ? failure.message : 'Build receipt check failed')
  process.exitCode = 1
}
