// 把真实 profiles 下所有符号链接在诊断副本里原样重建（目录用 junction，文件用硬链）。
// 用法: node scripts/diag-fix-links.mjs
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const realRoot = 'G:\\DSH-3-Portable\\Data\\DSH\\profiles'
const copyRoot = 'G:\\DSH-3-Portable\\Data\\Temp\\diag-home\\profiles'

function toWin(p) {
  // /g/DSH-3-Portable/... -> G:\DSH-3-Portable\...
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/)
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
  return path.win32.normalize(p)
}

const links = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue
      walk(full)
    } else if (entry.isSymbolicLink()) {
      links.push(full)
    }
  }
}
walk(realRoot)
console.log(`found ${links.length} symlinks`)

let junction = 0, hard = 0, skipped = 0, failed = 0
for (const link of links) {
  const rel = path.relative(realRoot, link)
  const copyLink = path.join(copyRoot, rel)
  let target = fs.readlinkSync(link)
  const isAbsolutePosix = target.startsWith('/')
  if (isAbsolutePosix) target = toWin(target)
  else target = path.resolve(path.dirname(link), target) // 相对链接解析成绝对
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (stat === undefined) { skipped++; continue }
  try {
    fs.rmSync(copyLink, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(copyLink), { recursive: true })
    if (stat.isDirectory()) {
      fs.symlinkSync(target, copyLink, 'junction')
      junction++
    } else {
      fs.linkSync(target, copyLink)
      hard++
    }
  } catch (error) {
    failed++
    console.error(`FAIL ${rel}: ${error.message}`)
  }
}
console.log(`junctions=${junction} hardlinks=${hard} skipped=${skipped} failed=${failed}`)
