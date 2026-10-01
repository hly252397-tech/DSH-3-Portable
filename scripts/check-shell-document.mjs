import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'

/** Validate source or packaged shell bytes before staging; never rewrite encoding. */
export function checkShellDocument(html, filename = 'shell.html') {
  const required = ['back', 'forward', 'restart-btn', 'menus', 'status', 'command-center']
  for (const id of required) {
    if (!html.includes(`id="${id}"`)) throw new Error(`${filename}: missing #${id}`)
  }
  let count = 0
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(match[1])) continue
    new Script(match[2], { filename: `${filename}:inline-${++count}` })
  }
  if (count < 2) throw new Error(`${filename}: missing shell bootstrap/action scripts`)
  if (html.includes('dsh-fwd-layer')) throw new Error(`${filename}: retired input-forwarding experiment`)
  return { scripts: count, required }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const filename = resolve(process.argv[2] || 'assets/shell.html')
  console.log(JSON.stringify(checkShellDocument(readFileSync(filename, 'utf8'), filename)))
}
