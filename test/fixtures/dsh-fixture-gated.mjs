import { createServer } from 'node:http'

// 模拟 0.1.5-alpha.1 的 bin.js 形态：runCli 导出 + import.meta.main 守卫，
// 用于回归桌面 bootstrap 对新一代入口的显式调用。
let server

process.on('SIGTERM', () => {
  if (server === undefined) process.exit(0)
  server.close(() => process.exit(0))
})

export async function runCli() {
  server = createServer((request, response) => {
    if (request.url === '/asset.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' })
      response.end('export {}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><script src="/asset.js"></script>')
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未获取 HTTP 监听端口。')
    process.stdout.write(`dsh web: http://127.0.0.1:${address.port}\n`)
  })
}

if (import.meta.main) await runCli()
