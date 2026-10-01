import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// 🔴 2026-09-21 事故固化：把 dshDesktopShell.action('app-restart') 写进**插件客户端 bundle**
// ⇒ 客户端 bundle 每次页面加载都执行 ⇒ 重启后页面又加载 ⇒ 又重启 ⇒ **无限重启**。
//
// 铁律：**客户端 bundle 里禁止出现任何重启/退出动作**。
//   · 客户端 bundle = 每次页面加载都会执行，放自调度动作等于"自动按重启键"
//   · 正确做法：重启/退出必须由**用户显式操作**触发，走受控通道
//     （既有范例 `local/dsh-restart-button`：本机 webServer + 共享密钥 + 必须显式 POST）
//   · 本用例只扫客户端半侧；宿主半侧（lib/index.js）可以合理地暴露"显式请求才触发"的端点
const FORBIDDEN = [
  /app-restart/,
  /app-quit/,
  /dshDesktopShell\s*\.\s*action\s*\(\s*['"](?:app-restart|app-quit)['"]/,
]

test('本地插件客户端 bundle 里不得出现重启/退出动作（防自调度重启）', t => {
  const root = 'Data/DSH/profiles/web/local'
  if (!existsSync(root)) return t.skip('实机 Profile 缺失（CI 全新检出）')

  const offenders: string[] = []
  for (const plugin of readdirSync(root)) {
    const dir = join(root, plugin)
    if (!statSync(dir).isDirectory()) continue
    for (const rel of ['lib/client.js', 'lib/client.src.js']) {
      const file = join(dir, rel)
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      for (const rx of FORBIDDEN) {
        if (rx.test(text)) offenders.push(`${plugin}/${rel} 命中 ${String(rx)}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `客户端 bundle 每次页面加载都会执行，禁止内置重启/退出动作（会造成无限重启）。请改为用户显式触发的受控通道。命中：${offenders.join(' | ')}`,
  )
})
