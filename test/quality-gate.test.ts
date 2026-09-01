import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const qualityGateUrl = new URL('../../docs/01-当前工作/便携版3-变更与答复质量门禁.md', import.meta.url)
const harnessPlanUrl = new URL('../../docs/03-技术架构/DeepSeek-Harness-企业级自动更新方案.md', import.meta.url)

test('质量门禁对专业级和企业级给出可验收定义', async () => {
  const source = await readFile(qualityGateUrl, 'utf8')
  assert.match(source, /### 0\.1 专业级/)
  assert.match(source, /事实准确/)
  assert.match(source, /可实施/)
  assert.match(source, /### 0\.2 企业级/)
  assert.match(source, /供应链安全/)
  assert.match(source, /A\/B 与自动回滚/)
  assert.match(source, /独立验收/)
  assert.match(source, /不得声称已经企业级投产/)
})

test('Harness 自动更新方案明确 A/B、影子验证、最小重启和未投产状态', async () => {
  const source = await readFile(harnessPlanUrl, 'utf8')
  assert.match(source, /企业级目标方案，尚未投产/)
  assert.match(source, /A\/B 运行时/)
  assert.match(source, /影子验证/)
  assert.match(source, /只重启 DSH 子服务/)
  assert.match(source, /自动回滚/)
  assert.match(source, /dsh-v0\.1\.2-alpha\.3/)
  assert.match(source, /SQLite Session/)
})
