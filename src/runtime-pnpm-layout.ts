import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeTextFileAtomic } from './atomic-file.js'

// pnpm 11's readModulesManifest resolves relative virtualStoreDir against node_modules
// on Windows too. Store a relative path before publishing an immutable slot.
export function normalizeRuntimePnpmLayout(source: string, directory: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { /* Older pnpm writes YAML. */ }
  let declared: unknown
  const json = parsed !== undefined
  if (json) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('无效的 pnpm 运行时元数据。')
    declared = (parsed as Record<string, unknown>).virtualStoreDir
  } else {
    const fields = [...source.matchAll(/^virtualStoreDir:[ \t]*(.+?)[ \t]*\r?$/gm)]
    if (fields.length !== 1) throw new Error('pnpm 元数据缺少唯一的 virtualStoreDir。')
    declared = fields[0]![1]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  if (typeof declared !== 'string' || declared.trim() === '') throw new Error('pnpm virtualStoreDir 无效。')
  if (resolve(directory, 'node_modules', declared) !== resolve(directory, 'node_modules', '.pnpm')) {
    throw new Error('pnpm virtualStoreDir 不属于当前候选，拒绝发布运行时。')
  }
  if (declared === '.pnpm') return source
  if (json) {
    (parsed as Record<string, unknown>).virtualStoreDir = '.pnpm'
    return JSON.stringify(parsed, undefined, 2) + '\n'
  }
  return source.replace(/^virtualStoreDir:[^\r\n]*/m, 'virtualStoreDir: .pnpm')
}

export async function prepareRuntimePnpmLayout(directory: string): Promise<void> {
  const metadata = join(directory, 'node_modules', '.modules.yaml')
  const info = await lstat(metadata)
  const store = await lstat(join(directory, 'node_modules', '.pnpm'))
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || !store.isDirectory() || store.isSymbolicLink()) {
    throw new Error('pnpm 运行时布局缺失、越界或过大，拒绝发布。')
  }
  const source = await readFile(metadata, 'utf8')
  const normalized = normalizeRuntimePnpmLayout(source, directory)
  if (normalized !== source) await writeTextFileAtomic(metadata, normalized)
}

export async function verifyRuntimePnpmLayout(directory: string): Promise<void> {
  const metadata = join(directory, 'node_modules', '.modules.yaml')
  const info = await lstat(metadata)
  const store = await lstat(join(directory, 'node_modules', '.pnpm'))
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || !store.isDirectory() || store.isSymbolicLink()) {
    throw new Error('已发布运行时的 pnpm 布局无效。')
  }
  const source = await readFile(metadata, 'utf8')
  if (normalizeRuntimePnpmLayout(source, directory) !== source) throw new Error('已发布运行时仍有绝对虚拟依赖路径，禁止原地修补。')
}
