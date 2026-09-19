import assert from 'node:assert/strict'
import test from 'node:test'

import { advanceStartupProgress, formatStartupProgress, parsePnpmProgress, STARTUP_PROGRESS } from '../src/startup-progress.js'

test('启动百分比只前进并被限制为整数 0–100', () => {
  assert.equal(advanceStartupProgress(45, 15), 45)
  assert.equal(advanceStartupProgress(45, 50.4), 50)
  assert.equal(advanceStartupProgress(97, 120), 100)
  assert.equal(advanceStartupProgress(-10, Number.NaN), 0)
})

test('启动阶段里程碑严格递增并以 100 完成', () => {
  const values = Object.values(STARTUP_PROGRESS)
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index] > values[index - 1])
  }
  assert.equal(values.at(-1), 100)
})

test('只解析完整锚定的 pnpm 进度行，其它输出不产生虚假进度', () => {
  assert.deepEqual(parsePnpmProgress('Progress: resolved 240, reused 231, downloaded 9, added 240'), {
    phase: 'install',
    detail: { resolved: 240, reused: 231, downloaded: 9, added: 240 },
  })
  assert.equal(parsePnpmProgress('  Progress: resolved 1, reused 0, downloaded 1, added 1'), undefined)
  assert.equal(parsePnpmProgress('Progress: resolved 1, reused 0'), undefined)
  assert.equal(parsePnpmProgress('other output'), undefined)
})

test('实测计量渲染真实计数细节，无总量或计量不可信时不虚构数字', () => {
  const bytes = formatStartupProgress({ phase: 'verify', completed: 5 * 1048576, total: 10 * 1048576, unit: 'bytes' }, true)
  assert.equal(bytes.message, '正在校验随包资源')
  assert.equal(bytes.detail, '5.0 / 10.0 MB')
  assert.deepEqual({ completed: bytes.completed, total: bytes.total }, { completed: 5 * 1048576, total: 10 * 1048576 })

  // 千分位随运行环境 locale 变化，用同一表达式取期望值，避免测试依赖本机区域设置。
  const entries = formatStartupProgress({ phase: 'extract', completed: 3201, total: 44116, unit: 'entries' }, true)
  assert.equal(entries.detail, `${(3201).toLocaleString()} / ${(44116).toLocaleString()} 项`)
  assert.equal(formatStartupProgress({ phase: 'extract', completed: 3201, total: 44116, unit: 'entries' }, false).detail,
    `${(3201).toLocaleString()} / ${(44116).toLocaleString()} entries`)

  // pnpm 只报计数不报总量：不得伪造 completed/total，否则进度条会假装在推进。
  const install = formatStartupProgress({ phase: 'install', detail: { resolved: 240, reused: 231, downloaded: 9, added: 240 } }, true)
  assert.equal(install.detail, '已解析 240 · 已复用 231 · 已下载 9 · 已安装 240')
  assert.equal(install.completed, undefined)
  assert.equal(install.total, undefined)

  // completed > total 属于不可信计量，同样不报数字。
  const broken = formatStartupProgress({ phase: 'copy', completed: 5, total: 3, unit: 'files' }, false)
  assert.equal(broken.detail, '')
  assert.equal(broken.completed, undefined)
  assert.equal(broken.total, undefined)
})
