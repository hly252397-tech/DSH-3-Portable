import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { makeTrackedTempDir, removeTempDir } from './helpers/tmp.js'
import { applyPendingProfileUpdates } from '../src/plugin-seed.js'

test('pending keeps an installed local junction across repeated starts and ignores registry replacement', async () => {
  const root = await makeTrackedTempDir(join(tmpdir(), 'pending-link-'))
  try {
    const local = join(root, 'local', 'custom'), modules = join(root, 'node_modules')
    await mkdir(local, { recursive: true }); await mkdir(modules)
    await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'custom', version: '0.1.0' }))
    await symlink(local, join(modules, 'custom'), process.platform === 'win32' ? 'junction' : 'dir')
    const manifest = JSON.stringify({ dependencies: { custom: 'link:local/custom' } })
    await writeFile(join(root, 'package.json'), manifest)
    await writeFile(join(root, '.dsh-pending-updates.json'), JSON.stringify({ packages: [{ packageName: 'custom', version: '9.0.0' }] }))
    for (let round = 0; round < 2; round++) {
      assert.deepEqual(await applyPendingProfileUpdates({ nodeExecutable: 'node', profileDir: root, pluginStoreDir: '', runner: async () => { throw new Error('spurious reinstall of local customizations') } }), [])
      assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest)
    }
  } finally { await removeTempDir(root) }
})

test('missing and wrongly directed local links are repaired, not treated as installed versions', async () => {
  const root = await makeTrackedTempDir(join(tmpdir(), 'pending-link-broken-'))
  try {
    const local = join(root, 'local'), wrong = join(root, 'wrong'), modules = join(root, 'node_modules')
    await mkdir(local); await mkdir(wrong); await mkdir(modules)
    for (const dir of [local, wrong]) await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'custom', version: '0.1.0' }))
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { custom: 'link:local' } }))
    for (const linked of [false, true]) {
      if (linked) await symlink(wrong, join(modules, 'custom'), process.platform === 'win32' ? 'junction' : 'dir')
      const calls: string[][] = []
      assert.deepEqual(await applyPendingProfileUpdates({ nodeExecutable: 'node', profileDir: root, pluginStoreDir: '', runner: async args => { calls.push([...args]) } }), ['custom'])
      assert.ok(calls[0]?.includes('custom@link:local'))
    }
  } finally { await removeTempDir(root) }
})

test('pending installation shares pnpm12 cache and preserves the request on failure', async () => {
  const root = await makeTrackedTempDir(join(tmpdir(), 'pending-cache-'))
  try {
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'package.json'), JSON.stringify({dependencies:{pkg:'1.0.0'}}))
    const request=JSON.stringify({packages:[{packageName:'pkg',version:'1.0.0'}]})
    await writeFile(join(root, '.dsh-pending-updates.json'),request)
    const store=join(root,'store','v11')
    await mkdir(store,{recursive:true})
    await writeFile(join(root,'node_modules','.modules.yaml'),`storeDir: ${JSON.stringify(store)}\n`)
    await assert.rejects(applyPendingProfileUpdates({nodeExecutable:'node',profileDir:root,pluginStoreDir:'',runner:async args=>{
      assert.equal(args.filter(x=>x.startsWith('--cache-dir=')).at(-1),'--cache-dir='+join(root,'store','cache'))
      throw new Error('policy rejected fixture')
    }}),/policy rejected fixture/)
    assert.equal(await readFile(join(root,'.dsh-pending-updates.json'),'utf8'),request)
  } finally { await removeTempDir(root) }
})
