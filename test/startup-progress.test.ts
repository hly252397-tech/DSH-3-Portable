import assert from 'node:assert/strict'
import test from 'node:test'

import { advanceStartupProgress, STARTUP_PROGRESS } from '../src/startup-progress.js'

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
