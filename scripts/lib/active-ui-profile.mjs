import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, parse, sep } from 'node:path'

function plain(directory) {
  const absolute = resolve(directory), anchor = parse(absolute).root
  let cursor = anchor
  for (const part of absolute.slice(anchor.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    const stat = lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Active profile path contains a link or non-directory')
  }
  if (relative(absolute, realpathSync(absolute)) !== '') throw new Error('Active profile path is not canonical')
  return absolute
}
const json = file => {
  plain(resolve(file, '..'))
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 256 * 1024) throw new Error('Invalid active profile metadata file')
  return JSON.parse(readFileSync(file, 'utf8'))
}
function present(file) {
  const absolute = resolve(file), anchor = parse(absolute).root
  let cursor = anchor
  const parts = absolute.slice(anchor.length).split(sep).filter(Boolean)
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part)
    let stat
    try { stat = lstatSync(cursor) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('Active profile metadata path contains a link or non-directory')
  }
  return true
}
function inside(root, path) {
  const full = resolve(root, path), rel = relative(root, full)
  if (!path || isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Invalid active runtime path: ${path}`)
  return full
}

/** Resolve exactly the runtime/home pair selected by the portable launcher. Never
 * silently fall back to the frozen home when an active binding is malformed. */
export function activeUiProfile(root) {
  root = plain(root)
  const pointerPath = resolve(root, 'Data/Runtime/Harness/current.json')
  if (!present(pointerPath)) return { profile: resolve(root, 'Data/DSH/profiles/web') }
  const pointer = json(pointerPath)
  const current = pointer.current
  if (pointer.schema !== 1 || !current || !/^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(current.version ?? '')) throw new Error('Invalid active runtime pointer')
  // An external diagnostic/installer cannot know whether this is a live
  // observation window or crash recovery. Never guess current or previous.
  if (Object.hasOwn(pointer, 'pendingTransactionId')) {
    throw Object.assign(new Error('Uncommitted runtime transaction; active Profile selection is blocked until normal recovery/commit'), { code: 'RUNTIME_TRANSACTION_PENDING' })
  }
  const runtime = inside(resolve(root, 'Data/Runtime'), current.relativePath)
  if (!/^Harness\/slots\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(current.relativePath ?? '')) throw new Error('Invalid active runtime slot path')
  plain(runtime)
  const bindingPath = resolve(root, 'Data/Updates/Harness/homes', `${current.version}.json`)
  if (!present(bindingPath)) return { runtime, profile: resolve(root, 'Data/DSH/profiles/web') }
  const binding = json(bindingPath)
  if ((binding.schema !== 1 && binding.schema !== 2) || binding.runtimeVersion !== current.version || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(binding.generation ?? '')) throw new Error('Invalid active home binding')
  if (binding.schema === 2 && binding.runtimeRelativePath !== `Data/Runtime/${current.relativePath}`) throw new Error('Active home/runtime mapping mismatch')
  const profile = resolve(root, 'Data/DSH-generations', binding.generation, 'home/profiles/web')
  if (!present(resolve(profile, 'package.json'))) throw new Error('Active UI Profile is missing')
  plain(profile)
  json(resolve(profile, 'package.json'))
  return { runtime, profile }
}
