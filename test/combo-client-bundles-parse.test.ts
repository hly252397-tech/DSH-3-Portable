import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

// 🔴 2026-09-22 事故固化：`dsh-hj-workbench/lib/client.js` 里同一作用域重复声明 `gpt`
// ⇒ 官方把所有插件的 client.js 拼成**一个** combo 响应
//   （`/plugins/??a/client.js,b/client.js,...`，见 dsh-client-modules）
// ⇒ 一处语法错让整包解析失败 ⇒ **76 条插件条目全部 import failed**，整个界面起不来。
//
// 铁律：凡参与 combo 的客户端 bundle 必须是**可解析的 ESM**。
//   · 语法错在浏览器里只表现为"所有插件都坏了"，排查成本极高，所以必须在门禁阶段拦下
//   · 用 `node --check` 而不是 TS parser：V8 在解析期就会报
//     "Identifier 'x' has already been declared"，这正是本次的错类
//   · 文件名必须是 .mjs：这些 bundle 用 import/export，.js 会被按 CommonJS 解析而误报
const ROOT = 'Data/DSH/profiles/web'

const bundlePaths: string[] = []
const collectFrom = (pkgDir: string) => {
  for (const rel of ['lib/client.js', 'client.js', 'lib/client/index.js']) {
    const file = join(pkgDir, rel)
    if (existsSync(file) && statSync(file).isFile()) {
      bundlePaths.push(file)
      return
    }
  }
}

const collectRoot = (dir: string) => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const scoped of readdirSync(full)) collectFrom(join(full, scoped))
    } else if (entry.isDirectory()) {
      collectFrom(full)
    }
  }
}

test('参与 combo 的客户端 bundle 必须能通过 V8 语法检查（防一处语法错打死全部插件）', t => {
  if (!existsSync(ROOT)) return t.skip('实机 Profile 缺失（CI 全新检出）')
  collectRoot(join(ROOT, 'local'))
  collectRoot(join(ROOT, 'node_modules'))
  assert.ok(bundlePaths.length > 0, '未扫到任何客户端 bundle，检查扫描根路径')

  const offenders: string[] = []
  for (const file of bundlePaths) {
    const probe = join(tmpdir(), `dsh-combo-syntax-${file.replace(/[^a-z0-9]/gi, '_')}.mjs`)
    cpSync(file, probe)
    try {
      execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' })
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error)
      const first = stderr.split('\n').find(line => line.includes('Error') || line.includes('SyntaxError')) ?? stderr.trim().split('\n')[0]
      offenders.push(`${file}: ${first ?? '语法检查失败'}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `客户端 bundle 会被拼进同一个 combo 响应，任一处语法错会让所有插件条目 import failed。命中：\n${offenders.join('\n')}`,
  )
})
