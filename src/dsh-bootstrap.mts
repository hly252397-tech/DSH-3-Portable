import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (entry === undefined) throw new Error('缺少 DSH 启动入口。')

let initialized = false
let shutdownRequested = false

function requestShutdown(): void {
  shutdownRequested = true
  if (initialized) process.emit('SIGTERM')
}

process.on('message', message => {
  if (message === 'shutdown') requestShutdown()
})
process.on('disconnect', requestShutdown)

process.argv = [process.execPath, entry, ...process.argv.slice(3)]
const imported = await import(pathToFileURL(entry).href)
initialized = true

if (shutdownRequested) process.emit('SIGTERM')

// 0.1.5+ 的 bin.js 用 import.meta.main 守卫自执行，被 import 时不会运行；
// 显式调用其导出的 runCli。旧版 import 即自跑且无该导出。
if (typeof imported?.runCli === 'function') await imported.runCli()
