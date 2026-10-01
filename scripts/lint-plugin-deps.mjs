#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeUiProfile } from './lib/active-ui-profile.mjs'
import { auditPluginDependencies } from './lib/plugin-deps-audit.mjs'

const root = process.cwd()
const active = activeUiProfile(root)
const audit = auditPluginDependencies(active.profile, active.runtime)
const results = [
  { name: '活动运行时与本地插件可定位', ok: Boolean(active.runtime) && audit.plugins.length > 0, measured: active.profile },
  ...[['links', '本地插件已启用且链接实际目标正确'], ['entries', '服务与客户端入口存在'], ['dependencies', '无 DSH 内部包重复依赖'], ['peers', '核心 peer 声明满足或既有精确批准有效（含预发布规则）']]
    .map(([key, name]) => ({ name, ok: audit[key].length === 0, measured: audit[key].join(' ; ') || (key === 'peers' && audit.approved.length
      ? '既有精确批准：' + audit.approved.map(item => `${item.packageVersion} → ${item.runtimeVersion}`).join(' ; ') + '（风险放行，不等于适配或实测通过）'
      : '无异常') })),
]
const pass = results.filter(r => r.ok).length
const status = pass === results.length ? 'pass' : 'fail'
const dir = resolve(root, 'Data/artifacts/plugin-deps-lint-' + new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ status, checkedAt: new Date().toISOString(), ...active, ...audit, results }, null, 2))
console.log('插件依赖治理 ' + status.toUpperCase() + ' (' + pass + '/' + results.length + ')')
for (const item of results) console.log((item.ok ? 'ok' : 'FAIL') + ' ' + item.name + ': ' + item.measured)
if (audit.compatibilityWarnings.length) console.log('批准元数据警告：' + audit.compatibilityWarnings.join(' ; '))
process.exitCode = status === 'pass' ? 0 : 1
