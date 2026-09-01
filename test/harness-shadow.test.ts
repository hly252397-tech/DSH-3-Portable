import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateHarnessShadowStart } from '../src/harness-shadow.js'

test('影子启动使用一次性最小 profile，成功后停止服务并清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shadow-'))
  try {
    let stopped = 0
    let shadowRoot = ''
    await validateHarnessShadowStart({
      updateRoot: root,
      start: async profile => {
        shadowRoot = profile.root
        assert.equal(profile.home.startsWith(root), true)
        const manifest = JSON.parse(await readFile(join(profile.profile, 'package.json'), 'utf8')) as { dependencies?: object; dsh?: { profile?: { bundles?: string[] } } }
        assert.deepEqual(manifest.dependencies, {})
        assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
        return { stop: async () => { stopped += 1 } }
      },
    })
    assert.equal(stopped, 1)
    assert.equal(existsSync(shadowRoot), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('影子启动失败也清理隔离 profile，不触碰用户数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shadow-failure-'))
  try {
    let shadowRoot = ''
    await assert.rejects(validateHarnessShadowStart({
      updateRoot: root,
      start: async profile => {
        shadowRoot = profile.root
        throw new Error('readiness failed')
      },
    }), /readiness failed/)
    assert.equal(existsSync(shadowRoot), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
