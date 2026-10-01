import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('three runner processes serialize; live holder survives age threshold and waiter timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runner-concurrency-'))
  const children: Promise<{ code: number | null, output: string }>[] = []
  // 持有时长必须**显著**大于「等待者的 1000ms 轮询间隔 + 其进程启动耗时 + 父进程发现 marker 的延迟」。
  // 否则持有者会在等待者真正检查之前就释放锁，等待者于是合法地拿到锁并退出 0 —— 那不是锁失效，
  // 是本用例的时序预算太紧。2026-09-29 实测：hold=2500 时约 1/4 概率误报，机器越忙越容易触发；
  // 取 12000 后 4/4 稳定，事件相位恒为 start,end,start,end,start,end（锁始终严格串行）。
  const hold = Number(process.env.DSH_TEST_LOCK_STRESS_MS ?? 12000)
  assert.ok(Number.isSafeInteger(hold) && hold >= 2500 && hold <= 180000)
  const runner = resolve('scripts/run-tests.mjs')
  const events = join(root, 'events.jsonl')
  const marker = join(root, 'started')
  try {
    for (const name of ['test', 'dist/test', 'temp']) await mkdir(join(root, name), { recursive: true })
    const body = `import {appendFileSync,writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
const event=phase=>appendFileSync(${JSON.stringify(events)},JSON.stringify({phase,pid:process.pid,at:Date.now()})+'\\n');
event('start');writeFileSync(${JSON.stringify(marker)},'ready');
await setTimeout(Number(process.env.FIXTURE_HOLD_MS));event('end');
`
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: '.', outDir: 'dist', module: 'NodeNext' }, include: ['test/*.ts'] }))
    await writeFile(join(root, 'test/fixture.test.ts'), body)
    const past = new Date(Date.now() - 5000)
    for (const name of ['tsconfig.json', 'test/fixture.test.ts']) await utimes(join(root, name), past, past)
    await writeFile(join(root, 'dist/test/fixture.test.js'), body)
    const run = (duration: number, wait: number) => {
      // These are independent test-runner processes, not nested node:test children.
      const environment = { ...process.env }
      delete environment.NODE_TEST_CONTEXT
      const child = spawn(process.execPath, [runner, 'dist/test/fixture.test.js'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...environment, TEMP: join(root, 'temp'), TMP: join(root, 'temp'), TMPDIR: join(root, 'temp'),
          DSH_TEST_NO_LOCK: '0', DSH_TEST_LOCK_WAIT_MS: String(wait),
          DSH_TEST_LOCK_STALE_MS: hold > 120000 ? '120000' : '100', FIXTURE_HOLD_MS: String(duration) },
      })
      const promise = new Promise<{ code: number | null, output: string }>((res, rej) => {
        let output = ''
        child.stdout.on('data', value => { output += value })
        child.stderr.on('data', value => { output += value })
        child.once('error', rej)
        child.once('exit', code => res({ code, output }))
      })
      children.push(promise)
      return promise
    }
    const first = run(hold, 300000)
    const deadline = Date.now() + 15000
    while (!existsSync(marker) && Date.now() < deadline) await delay(50)
    if (!existsSync(marker)) {
      const result = await first
      assert.fail(`holder did not enter test (exit ${result.code}): ${result.output}`)
    }
    const timedOut = run(50, 100)
    const second = run(50, 300000)
    const third = run(50, 300000)
    const timeoutResult = await timedOut
    assert.notEqual(timeoutResult.code, 0)
    assert.match(timeoutResult.output, /等待测试锁超时/)
    for (const result of await Promise.all([first, second, third])) assert.equal(result.code, 0, result.output)
    const log = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(log.length, 6)
    assert.deepEqual(log.map(x => x.phase), ['start', 'end', 'start', 'end', 'start', 'end'])
    for (let i = 0; i < log.length; i += 2) assert.equal(log[i].pid, log[i + 1].pid)
    assert.equal(existsSync(join(root, 'temp/dsh-test-runs/run-tests.lock')), false)
  } finally {
    await Promise.allSettled(children)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
