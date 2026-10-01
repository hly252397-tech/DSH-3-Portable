import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

// 🔴 2026-10-01 事故固化：1.0.78+build.1 被回滚到 1.0.77，而**用户全程没有任何提示**。
//
// 事故有两条独立成因，本用例各锁一条：
//
// ① 降级被当成"正常"发布。`Save-RecoveredDesktopPointer` 在把指针退回上一槽时统一写
//    `Set-UpdateState -Phase 'none'`，而 src/main.ts 的 `applyPortableDesktopUpdateState`
//    把 'none' 映射成 `kind:'none'` —— 外壳文案是"当前已是最新版本"。
//    ⇒ 用户跑着一个旧槽，顶栏却说已是最新。**降级必须发 `rolled-back`。**
//
// ② 已提交的候选被二次降级。健康文件 13:38:44 就落盘、events.jsonl 也记了 completed，
//    但启动器仍按 3 分钟进度租约空等到期（13:41:45）后走回退分支，
//    把一个**已经提交的 1.0.78 降级成 1.0.77**。
//    ⇒ 回退前必须核对"指针是否已被候选进程提交"，已提交即拒绝降级。
//
// 另：黄色警告胶囊在顶部栏重启按钮**左边**，两端半圆，用户要求可见。
const root = resolve(import.meta.dirname, '..', '..')
const launcher = readFileSync(join(root, 'Start-DSH-Portable.ps1'), 'utf8')
const shell = readFileSync(join(root, 'assets/shell.html'), 'utf8')

test('① 指针降级必须记为 rolled-back，不得伪装成 none（防降级静默）', () => {
  const recover = launcher.slice(
    launcher.indexOf('function Save-RecoveredDesktopPointer'),
    launcher.indexOf('function Set-UpdateState'),
  )
  assert.ok(recover.length > 0, 'Save-RecoveredDesktopPointer 必须存在')
  // 有降级原因时必须写 rolled-back。
  assert.match(
    recover,
    /if\s*\(\s*-not\s+\[string\]::IsNullOrWhiteSpace\(\$DowngradeReason\)\s*\)\s*\{[\s\S]*Set-UpdateState -Phase 'rolled-back'/,
    '带 DowngradeReason 的恢复路径必须写 -Phase \'rolled-back\'',
  )
  // 无降级原因的正常恢复才允许 'none'，且不得与降级分支共用同一句。
  // 取最后一个 '} else {' —— 前面那个是三元表达式里的 else。
  const normalBranch = recover.slice(recover.lastIndexOf('} else {'))
  assert.ok(normalBranch.length > 0, '必须存在"无降级原因"的正常恢复分支')
  assert.doesNotMatch(
    normalBranch,
    /Set-UpdateState -Phase 'rolled-back'/,
    '正常恢复（none）分支不得写 rolled-back',
  )
  assert.match(
    normalBranch,
    /Set-UpdateState -Phase 'none'[\s\S]*已恢复桌面槽指针/,
    '正常恢复分支才允许写 \'none\'',
  )
})

test('①b 降级时必须显式记录被撤回的版本，否则外壳无从提示', () => {
  // 候选撤回后指针已无 pending，targetVersion 只能由调用方显式传入。
  const setState = launcher.slice(
    launcher.indexOf('function Set-UpdateState'),
    launcher.indexOf('function ', launcher.indexOf('function Set-UpdateState') + 10),
  )
  assert.match(
    setState,
    /function Set-UpdateState \{[\s\S]*?\[string\]\$TargetVersion/,
    'Set-UpdateState 必须接受 $TargetVersion 参数',
  )
  assert.match(
    setState,
    /IsNullOrWhiteSpace\(\s*\$TargetVersion\s*\)/,
    'TargetVersion 为空时须回退到 pending 版本',
  )
  // 四条回退调用点都必须带上被撤回的版本。
  const reverts = launcher.match(/Restore-CurrentDesktopPointer -Pointer \$freshPointer -Detail '[^']*' -RevertedVersion/g) ?? []
  assert.equal(
    reverts.length,
    4,
    `四条候选失败路径都必须传 -RevertedVersion，实际 ${reverts.length} 条：\n${reverts.join('\n')}`,
  )
  const restore = launcher.slice(
    launcher.indexOf('function Restore-CurrentDesktopPointer'),
    launcher.indexOf('function ', launcher.indexOf('function Restore-CurrentDesktopPointer') + 10),
  )
  assert.match(
    restore,
    /Set-UpdateState -Phase 'rolled-back'[\s\S]*-TargetVersion \$RevertedVersion/,
    'Restore-CurrentDesktopPointer 必须把被撤回版本写进 targetVersion',
  )
})

test('② 回退前必须核对候选指针是否已提交（防误降级健康候选）', () => {
  const activate = launcher.slice(launcher.indexOf('function Invoke-PendingDesktopActivation'))
  const guard = activate.indexOf("Write-LauncherLog '候选指针已由运行中的候选进程提交，拒绝按旧快照降级。'")
  assert.ok(guard > 0, '回退 CAS 内必须有提交守卫')
  const window = activate.slice(Math.max(0, guard - 400), guard + 400)
  assert.match(
    window,
    /Test-DesktopReferenceMatch \(\s*Get-OptionalProperty \$freshPointer -Name 'current'\s*\)\s*\$pendingReference/,
    '守卫必须比较 freshPointer.current 与 pendingReference',
  )
  assert.match(
    window,
    /return \[pscustomobject\]@\{ Status = 'committed' \}/,
    '命中守卫必须以 committed 返回，不得继续降级',
  )
})

test('②b 等待提交需有诊断出口，不能静默空转到租约到期', () => {
  const activate = launcher.slice(launcher.indexOf('function Invoke-PendingDesktopActivation'))
  assert.match(
    activate,
    /\$publishDeadline = \(Get-Date\)\.AddSeconds\(\d+\)/,
    '提交等待必须设置诊断截止时间',
  )
  assert.match(
    activate,
    /\$confirmation\.Status -eq 'candidate-current'[\s\S]{0,400}?\$publishDiagnosticWritten[\s\S]{0,400}?state\.transactionId/,
    '到达诊断截止必须把 state.phase / transactionId 写进日志',
  )
})

test('③ 顶部栏重启按钮左侧存在黄色半圆警告胶囊', () => {
  const capsuleAt = shell.indexOf('id="rollback-capsule"')
  const restartAt = shell.indexOf('id="restart-btn"')
  assert.ok(capsuleAt > 0 && restartAt > 0, '外壳必须有胶囊与重启按钮')
  assert.ok(capsuleAt < restartAt, '胶囊必须排在重启按钮左边（DOM 顺序即视觉顺序）')
  // 与重启按钮同处 .bar-right，才能落在顶栏右侧。
  const barRightAt = shell.lastIndexOf('<div class="bar-right">', capsuleAt)
  assert.ok(barRightAt > 0 && shell.indexOf('</div>', restartAt) > capsuleAt, '胶囊与重启按钮必须同在 .bar-right 内')

  const css = shell.match(/\.rollback-capsule\{[^}]*\}/)?.[0] ?? ''
  assert.match(css, /background:#fadb14/i, '胶囊底色必须是警示黄 #fadb14')
  assert.match(css, /color:#3d2b00/i, '胶囊文字必须是深色以保证对比度')
  // 两端半圆：圆角 = 高度的一半（11px / height:22px），或等价的 999px。
  const radius = Number(/border-radius:(\d+)px/.exec(css)?.[1] ?? NaN)
  const height = Number(/height:(\d+)px/.exec(css)?.[1] ?? NaN)
  assert.ok(
    !Number.isNaN(radius) && !Number.isNaN(height) && radius * 2 === height,
    `胶囊两端须为半圆：border-radius 须等于高度一半（实得 ${radius}px / ${height}px）`,
  )
  // 默认隐藏，只在 rolled-back 时显示，避免污染常规顶栏。
  assert.match(css, /display:none/, '胶囊默认必须隐藏')
  assert.match(
    shell,
    /\.rollback-capsule\[data-visible="true"\]\{display:inline-flex\}/,
    '胶囊必须由 data-visible 驱动显隐',
  )
})

test('③b 胶囊只对 rolled-back 生效，其余状态一律隐藏', () => {
  const fn = shell.slice(shell.indexOf('function renderRollbackCapsule'), shell.indexOf('function renderDesktopUpdate'))
  assert.ok(fn.length > 0, '必须有 renderRollbackCapsule')
  assert.match(
    fn,
    /String\(update\.kind\)\s*===\s*'rolled-back'/,
    '显示条件必须是 status.kind === \'rolled-back\'',
  )
  assert.match(fn, /capsule\.dataset\.visible=String\(rolled\)/, '必须把判定结果写进 data-visible')
  assert.match(
    fn,
    /if\(!rolled\)\{[\s\S]*?textContent=''[\s\S]*?return\}/,
    '非回退态必须清空文本并直接返回',
  )
  // 提示文案必须同时带"被撤回的版本"与"当前运行的版本"，否则用户不知道降到了哪。
  assert.match(fn, /update\.version/, '必须读取被撤回版本（status.version）')
  assert.match(fn, /value\.currentVersion/, '必须读取当前运行版本')
  assert.match(fn, /capsule\.title=detail/, '必须挂 title 承载完整降级原因')
  // 渲染入口必须接上，否则胶囊永远不出现。
  const render = shell.slice(shell.indexOf('function renderDesktopUpdate'), shell.indexOf('function clearOpenMenu'))
  assert.match(render, /renderRollbackCapsule\(value\)/, 'renderDesktopUpdate 必须调用 renderRollbackCapsule')
})
