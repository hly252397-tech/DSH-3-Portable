// dsh-ui-tweaks —— 宿主侧：只提供一条「客户端热重载令牌」路由。
//
// 为什么需要它（2026-09-15 用户指出「重启后会话就停了」的根因修复）：
//   外壳的插件热重载走 `.dsh-reload-request` → recycleDshForPluginUpdate()，那是**整运行时回收**，
//   会把正在跑对话的 DSH 进程一起杀掉 —— 界面还没改完，会话先断了。
//   而我们真正需要的只是「让页面重新拉一次客户端 bundle」（bundle 是每次请求现读磁盘的）。
//   → 宿主每请求现算一次 client.js 的 mtime 当令牌；客户端轮询到令牌变了就 location.reload()。
//   → 从此改样式/布局只刷新页面，DSH 运行时不动，会话不丢。
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-ui-tweaks'
export const inject = ['webServer']

const CLIENT_PATH = fileURLToPath(new URL('./client.js', import.meta.url))
const TOKEN_PATH = '/ui-tweaks/reload-token'

function header(headers, key) {
  const value = headers?.[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try { return new URL('http://' + authority) } catch { return undefined }
}

function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function apply(ctx) {
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: TOKEN_PATH,
      handler: (req, res) => {
        const authority = header(req.headers, 'host')
        const hostUrl = authority === undefined ? undefined : parseAuthority(authority)
        const trusted = hostUrl !== undefined && isLoopback(hostUrl.hostname) && header(req.headers, 'sec-fetch-site') !== 'cross-site'
        res.statusCode = trusted ? 200 : 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        let token = 0
        if (trusted) {
          try { token = Math.round(statSync(CLIENT_PATH).mtimeMs) } catch { token = 0 }
        }
        res.end(JSON.stringify(trusted ? { ok: true, token } : { ok: false }))
      },
    })
    return () => unregister()
  }, 'dsh-ui-tweaks: client hot-reload token')
}
