import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_NODE } from './gate-node.mjs'

/** Use the compiler's resolved config; TS 7 no longer exports the old compiler API. */
export function assertFreshTestBuild(root) {
  const configPath = resolve(root, 'tsconfig.json')
  const compiler = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/typescript/bin/tsc')
  const shown = spawnSync(GATE_NODE, [compiler, '--showConfig', '--project', configPath], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  if (shown.error || shown.status !== 0) throw new Error(`Cannot resolve test compiler config: ${shown.error?.message ?? shown.stdout + shown.stderr}`)
  const parsed = JSON.parse(shown.stdout)
  const options = parsed.compilerOptions ?? {}
  if (!options.rootDir || !options.outDir || options.noEmit || options.outFile) throw new Error('Test freshness requires explicit rootDir/outDir and normal file emission')
  const outputRoot = resolve(root, options.outDir)
  const sourceRoot = resolve(root, options.rootDir)
  const configTime = statSync(configPath).mtimeMs
  const expected = new Set()
  const problems = []
  for (const name of parsed.files ?? []) {
    const input = resolve(root, name)
    if (/\.d\.(?:ts|mts|cts)$/.test(input)) continue
    if (!/\.(?:ts|tsx|mts|cts)$/.test(input)) throw new Error(`Unsupported compiler input: ${input}`)
    const extension = input.endsWith('.mts') ? '.mjs' : input.endsWith('.cts') ? '.cjs' : input.endsWith('.tsx') && options.jsx === 'preserve' ? '.jsx' : '.js'
    const stem = resolve(outputRoot, relative(sourceRoot, input)).replace(/\.(?:ts|tsx|mts|cts)$/, '')
    const outputs = options.emitDeclarationOnly ? [] : [stem + extension]
    if (options.sourceMap && !options.emitDeclarationOnly) outputs.push(stem + extension + '.map')
    if (options.declaration || options.composite) {
      const declaration = stem + (extension === '.mjs' ? '.d.mts' : extension === '.cjs' ? '.d.cts' : '.d.ts')
      outputs.push(declaration)
      if (options.declarationMap) outputs.push(declaration + '.map')
    }
    for (const output of outputs) {
      expected.add(resolve(output))
      if (!existsSync(output)) problems.push(`missing: ${output}`)
      else if (statSync(output).mtimeMs < Math.max(statSync(input).mtimeMs, configTime)) problems.push(`stale: ${output} <- ${input}`)
    }
  }
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && /\.test\.(?:js|mjs|cjs)$/.test(file) && !expected.has(resolve(file))) problems.push(`orphan test: ${file}`)
    }
  }
  walk(join(outputRoot, 'test'))
  if (!expected.size) problems.push('no compiler outputs')
  if (problems.length) throw new Error(`[test-run] 编译产物缺失/陈旧，拒绝测试。先用门禁 Node 运行 tsc；删除源文件后须审查并清理对应旧产物。\n${problems.slice(0, 20).join('\n')}`)
}
