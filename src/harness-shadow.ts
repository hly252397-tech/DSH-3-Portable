import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { OFFICIAL_PROFILE_BUNDLES } from './bundled-plugins.js'

export interface HarnessShadowProfile {
  readonly root: string
  readonly home: string
  readonly profile: string
}

export async function createHarnessShadowProfile(updateRoot: string): Promise<HarnessShadowProfile> {
  const canaryRoot = join(updateRoot, 'canary')
  await mkdir(canaryRoot, { recursive: true })
  const root = await mkdtemp(join(canaryRoot, 'shadow-'))
  const home = join(root, 'Home')
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-desktop-shadow-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...OFFICIAL_PROFILE_BUNDLES] } },
  }, undefined, 2)}\n`, 'utf8')
  await writeFile(join(profile, 'cordis.patch.yml'), '# Isolated updater canary: no user or community configuration.\n[]\n', 'utf8')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n', 'utf8')
  return { root, home, profile }
}

/**
 * 使用一次性 DSH_HOME 做真实启动/HTTP readiness 验证。候选永远看不到用户的
 * profiles、会话和社区插件；成功与失败都会清理 canary 数据。
 */
export async function validateHarnessShadowStart<T extends { stop: () => Promise<void> }>(options: {
  updateRoot: string
  start: (profile: HarnessShadowProfile) => Promise<T>
}): Promise<void> {
  const profile = await createHarnessShadowProfile(options.updateRoot)
  let server: T | undefined
  try {
    server = await options.start(profile)
  } finally {
    await server?.stop().catch(() => undefined)
    await rm(profile.root, { recursive: true, force: true }).catch(() => undefined)
  }
}
