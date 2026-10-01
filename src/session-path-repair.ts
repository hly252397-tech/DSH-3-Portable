import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export interface SessionPathRepair {
  readonly from: string
  readonly to: string
  readonly backup: string
  readonly sessionId: string
}

export interface SessionPathRepairResult {
  readonly repairs: readonly SessionPathRepair[]
  /** 单个会话自愈失败的清单。调用方**不得**因为非空而中断启动流程。 */
  readonly failures: readonly string[]
}

interface SessionHeader {
  readonly type: 'session'
  readonly id: string
  readonly cwd?: string
}

/** Optional startup maintenance: filesystem traversal and reporting failures must not stop DSH. */
export async function runSessionPathRepairAtStartup(
  sessionRoot: string,
  backupRoot: string,
  report: (result: SessionPathRepairResult) => Promise<void>,
): Promise<void> {
  try {
    await report(await repairMisplacedSessionLogs(sessionRoot, backupRoot))
  } catch (error) {
    console.warn('会话路径自愈未完成，保留原始数据并继续启动。', error)
  }
}

/**
 * Repair the narrow failure mode where a valid session header points at a
 * different project directory than the physical log. The log bytes are never
 * rewritten: a backup is published first, then the complete session directory
 * is atomically renamed on the same volume.
 *
 * 单会话失败只记入 `failures`，**不抛错、不删备份**：本函数在启动路径上调用，
 * 一个坏会话不得让整个启动失败；备份是唯一还原依据，必须在失败后仍然存在。
 */
export async function repairMisplacedSessionLogs(sessionRoot: string, backupRoot: string): Promise<SessionPathRepairResult> {
  const root = resolve(sessionRoot)
  const repairs: SessionPathRepair[] = []
  const failures: string[] = []
  if (!existsSync(root)) return { repairs, failures }

  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionPath = join(projectPath, session.name)
      // 单个会话失败只记账并继续：启动路径不能再因为一个坏会话整体抛错。
      try {
        const logName = await findSessionLog(sessionPath)
        if (logName === undefined) continue
        const logPath = join(sessionPath, logName)
        const header = await readSessionHeader(logPath)
        const expectedDirectory = join(root, projectKey(header.cwd), encodeSegment(header.id))
        const expectedLog = join(expectedDirectory, logName)
        if (samePath(logPath, expectedLog)) continue
        assertWithin(root, expectedDirectory)
        if (existsSync(expectedDirectory)) {
          failures.push(`${session.name}：目标会话 ${header.id} 已存在，未移动。`)
          continue
        }

        const relativeLog = relative(root, logPath)
        const backup = join(resolve(backupRoot), relativeLog)
        assertWithin(resolve(backupRoot), backup)
        await mkdir(dirname(backup), { recursive: true })
        // 备份幂等：已有备份且内容一致 ⇒ 视为已完成（崩溃后重跑不再 EEXIST）；
        // 内容不一致 ⇒ 明确报错，绝不静默覆盖。
        const backupMissing = !existsSync(backup)
        if (backupMissing) {
          await copyFile(logPath, backup, 0x1)
        } else {
          const [existingDigest, currentDigest] = await Promise.all([sha256File(backup), sha256File(logPath)])
          if (existingDigest !== currentDigest) {
            failures.push(`${session.name}：备份 ${backup} 已存在且内容不一致，已停止该会话的自愈。`)
            continue
          }
        }
        await mkdir(dirname(expectedDirectory), { recursive: true })
        await rename(sessionPath, expectedDirectory)
        repairs.push({ from: sessionPath, to: expectedDirectory, backup, sessionId: header.id })
      } catch (error) {
        // 失败**不删备份**：备份是唯一还原依据。只记账。
        failures.push(`${session.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { repairs, failures }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function findSessionLog(sessionPath: string): Promise<string | undefined> {
  const candidates = (await readdir(sessionPath, { withFileTypes: true }))
    .filter(entry => entry.isFile() && (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd'))
    .map(entry => entry.name)
  if (candidates.length > 1) throw new Error(`会话路径自愈已安全停止：${basename(sessionPath)} 同时存在两种日志编码。`)
  return candidates[0]
}

async function readSessionHeader(path: string): Promise<SessionHeader> {
  const handle = await open(path, 'r')
  try {
    const compressed = path.endsWith('.zstd')
    const bytes = await handle.readFile()
    const text = (compressed ? zstdDecompressSync(bytes) : bytes).toString('utf8')
    const newline = text.indexOf('\n')
    const value = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as Partial<SessionHeader>
    if (value.type !== 'session' || typeof value.id !== 'string' || value.id === '' || (value.cwd !== undefined && typeof value.cwd !== 'string')) {
      throw new Error('会话头格式无效。')
    }
    return value as SessionHeader
  } catch (error) {
    throw new Error(`无法验证会话 ${basename(dirname(path))} 的头部，未执行路径自愈。`, { cause: error })
  } finally {
    await handle.close()
  }
}

function projectKey(cwd: string | undefined): string {
  if (cwd === undefined) return '_no-cwd'
  if (cwd.length === 0) throw new Error('会话 cwd 不能为空。')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function encodeSegment(value: string): string {
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const character = String.fromCharCode(code)
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase()
    : resolve(left) === resolve(right)
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '' || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../')) {
    throw new Error('会话路径自愈拒绝访问便携会话目录之外的路径。')
  }
}
