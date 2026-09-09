import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const qualityGateUrl = new URL('../../docs/01-当前工作/便携版3-变更与答复质量门禁.md', import.meta.url)
const harnessPlanUrl = new URL('../../docs/03-技术架构/DeepSeek-Harness-企业级自动更新方案.md', import.meta.url)
const officialBaselineUrl = new URL('../../docs/03-技术架构/DeepSeek-Harness-官方兼容基线.json', import.meta.url)
const officialBaselineDocUrl = new URL('../../docs/03-技术架构/DeepSeek-Harness-官方兼容基线.md', import.meta.url)
const desktopManifestUrl = new URL('../../package.json', import.meta.url)
const officialCheckScriptUrl = new URL('../../scripts/verify-dsh-official-baseline.mjs', import.meta.url)

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

test('统一更新方案明确 A/B、影子验证、可视进度、最小重启和未投产状态', async () => {
  const source = await readFile(harnessPlanUrl, 'utf8')
  assert.match(source, /企业级候选实现；尚未宣称企业级投产/)
  assert.match(source, /A\/B/)
  assert.match(source, /影子(?:启动|验证)/)
  assert.match(source, /只重启 DSH 子服务/)
  assert.match(source, /自动回滚/)
  assert.match(source, /检测、下载、验证、构建、部署、完成/)
  assert.match(source, /0\.1\.2-alpha\.5/)
  assert.match(source, /故障注入矩阵/)
})

test('官方兼容基线区分内置实现版本与官方最新审查版本', async () => {
  const baseline = JSON.parse(await readFile(officialBaselineUrl, 'utf8'))
  const desktopManifest = JSON.parse(await readFile(desktopManifestUrl, 'utf8'))
  const documentation = await readFile(officialBaselineDocUrl, 'utf8')
  const checker = await readFile(officialCheckScriptUrl, 'utf8')

  assert.equal(baseline.bundled.dshVersion, desktopManifest.config.bundledDshVersion)
  assert.match(baseline.official.commit, /^[0-9a-f]{40}$/)
  assert.match(baseline.official.repository, /^https:\/\/github\.com\/deepseek-ai\/deepseek-harness\.git$/)
  assert.equal(baseline.policy.requireOnlineHeadCheckBeforeFeatureWork, true)
  assert.equal(baseline.policy.allowAutomaticBaselineRewrite, false)
  assert.match(documentation, /实现基线/)
  assert.match(documentation, /审查基线/)
  assert.match(documentation, /不能看到新文档就直接调用旧运行时中不存在的接口/)
  assert.match(checker, /api\.github\.com\/repos\/deepseek-ai\/deepseek-harness\/commits\/master/)
  assert.match(checker, /raw\.githubusercontent\.com\/deepseek-ai\/deepseek-harness/)
})

test('质量门禁要求每个功能执行官方在线预检和真实组合验证', async () => {
  const source = await readFile(qualityGateUrl, 'utf8')
  assert.match(source, /verify-dsh-official-baseline\.mjs --online/)
  assert.match(source, /官方 HEAD 变化时必须先人工审阅/)
  assert.match(source, /真实 Profile\/Loader 组合测试/)
  assert.match(source, /事务提交点后发布/)
})
