import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// 实机 sidebar-spaces 源码里的 overviewStats（数据库模块总览统计）；CI 缺失时跳过。
const sourcePath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js')
const haveLive = existsSync(sourcePath)

test('数据库总览统计：填充率/唯一值/数值范围', async t => {
  if (!haveLive) return t.skip('实机 sidebar-spaces 源码缺失（CI 全新检出）')
  const source = await readFile(sourcePath, 'utf8')
  const start = source.indexOf('function overviewStats(')
  assert.ok(start >= 0, 'overviewStats 必须存在')
  const end = source.indexOf('\n\t\t}', start)
  const fn = runInNewContext(`(${source.slice(start, end + 6)})`)
  const fields = [
    { id: 'n', name: '数值', type: 'number' },
    { id: 't', name: '文本', type: 'text' },
  ]
  const records = [
    { cells: { n: 3, t: '甲' } },
    { cells: { n: 7 } },
    { cells: { n: 5, t: '甲' } },
  ]
  const stats = fn(fields, records)
  assert.equal(stats.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(stats[0])), { id: 'n', name: '数值', type: 'number', total: 3, filled: 3, fillRate: 100, unique: 3, min: 3, max: 7 })
  assert.equal(stats[1].filled, 2)
  assert.equal(stats[1].fillRate, 67)
  assert.equal(stats[1].unique, 1)
  assert.equal(stats[1].min, null)
})

test('数据库总览视图已接入视图切换与内容分支', async t => {
  if (!haveLive) return t.skip('实机 sidebar-spaces 源码缺失（CI 全新检出）')
  const source = await readFile(sourcePath, 'utf8')
  assert.match(source, /setView\("overview"\)/)
  assert.match(source, /view === "overview" \? h\(OverviewPanel/)
  assert.match(source, /dss-overview-grid/)
})
