import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './gate-node.mjs'

/** Diagnostic tools must not silently borrow pnpm from an obsolete App tree. */
export function resolveGatePnpm(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)(?:\+.*)?$/.exec(manifest.packageManager ?? '')
  if (!match) throw new Error('清单缺少有效 pnpm 版本。')
  const version = match[1]
  for (const candidate of [
    join(root, 'Tools', `pnpm-v${version}`, 'node_modules', 'pnpm'),
    join(root, 'runtime-node', 'pnpm-package'),
  ]) {
    const file = join(candidate, 'package.json')
    if (!existsSync(file)) continue
    const actual = JSON.parse(readFileSync(file, 'utf8'))
    if (actual.name !== 'pnpm' || actual.version !== version) continue
    for (const entry of ['bin/pnpm.mjs', 'bin/pnpm.cjs']) {
      if (existsSync(join(candidate, entry))) return join(candidate, entry)
    }
  }
  throw new Error(`未找到清单要求的 pnpm ${version} Node 入口；先准备版本工具目录。`)
}
