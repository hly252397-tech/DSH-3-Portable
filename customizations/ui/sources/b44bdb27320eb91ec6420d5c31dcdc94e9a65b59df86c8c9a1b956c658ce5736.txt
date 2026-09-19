import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkbench } from '../Customize/Automation-Workbench/build.mjs'

export function restoreScheduledTasksEntry(source) {
  return buildWorkbench(source)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve('Data/DSH/profiles/web/node_modules/@michengai/dsh-automation/lib/client.js')
  const before = await readFile(file, 'utf8'), after = restoreScheduledTasksEntry(before)
  if (before !== after) {
    const backup = resolve('Data/Development/automation-entry-backups', String(Date.now()))
    await mkdir(backup, { recursive: true }); await copyFile(file, resolve(backup, 'client.js'))
    await writeFile(file, after)
  }
  console.log(before === after ? 'Scheduled tasks entry already restored' : 'Restored scheduled-tasks page; removed standalone footer launcher. Task data unchanged.')
}
