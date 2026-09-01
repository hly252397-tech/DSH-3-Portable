import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'
import { inspectProfileBundle } from './profile-bundle-health.js'

export type ProfileQuarantineSource = 'preflight' | 'startup' | 'runtime'

interface ProfileQuarantineRecord {
  readonly id: string
  readonly packageName: string
  readonly reason: string
  readonly source: ProfileQuarantineSource
  readonly createdAt: string
  readonly fingerprint: string
  readonly dependencySpec?: string
  readonly manifestBackup: string
  readonly resolvedAt?: string
}

interface ProfileQuarantineJournal {
  readonly version: 1
  readonly records: ProfileQuarantineRecord[]
}

export function profileQuarantineJournalPath(profileDir: string): string {
  return join(profileDir, '.dsh-recovery', 'quarantined-bundles.json')
}

export async function activeQuarantinedProfileBundles(profileDir: string): Promise<ReadonlySet<string>> {
  const journal = await readJournal(profileDir)
  const active = new Set<string>()
  let changed = false
  const checkedAt = new Date().toISOString()
  for (const record of journal.records) {
    if (record.resolvedAt !== undefined) continue
    const health = inspectProfileBundle(profileDir, record.packageName)
    if (health.fingerprint === record.fingerprint || !health.loadable) {
      active.add(record.packageName)
      continue
    }
    ;(record as { resolvedAt?: string }).resolvedAt = checkedAt
    changed = true
  }
  if (changed) await writeJournal(profileDir, journal)
  return active
}

export async function quarantineProfileBundle(
  profileDir: string,
  packageName: string,
  reason: string,
  source: ProfileQuarantineSource,
  options: { writeAtomic?: typeof writeTextFileAtomic } = {},
): Promise<boolean> {
  const writeAtomic = options.writeAtomic ?? writeTextFileAtomic
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  const original = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(original) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const current = manifest.dsh?.profile?.bundles ?? []
  if (!current.includes(packageName)) return false

  const recoveryRoot = join(profileDir, '.dsh-recovery')
  const backupRoot = join(recoveryRoot, 'manifest-backups')
  await mkdir(backupRoot, { recursive: true })
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const backupName = `${id}-${packageName.replace(/[^a-z0-9@._-]/gi, '_')}.json`
  const backupPath = join(backupRoot, backupName)
  await copyFile(manifestPath, backupPath)

  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: current.filter(name => name !== packageName) },
  }
  const nextManifest = `${JSON.stringify(manifest, undefined, 2)}\n`
  const journal = await readJournal(profileDir)
  const record: ProfileQuarantineRecord = {
    id,
    packageName,
    reason: reason.slice(0, 2_000),
    source,
    createdAt: new Date().toISOString(),
    fingerprint: inspectProfileBundle(profileDir, packageName).fingerprint,
    ...(manifest.dependencies?.[packageName] === undefined ? {} : { dependencySpec: manifest.dependencies[packageName] }),
    manifestBackup: join('manifest-backups', backupName).replaceAll('\\', '/'),
  }
  await writeAtomic(manifestPath, nextManifest)
  try {
    await writeJournal(profileDir, {
      version: 1,
      records: [...journal.records, record],
    }, writeAtomic)
  } catch (error) {
    await writeAtomic(manifestPath, original)
    throw error
  }
  return true
}

async function writeJournal(
  profileDir: string,
  journal: ProfileQuarantineJournal,
  writeAtomic: typeof writeTextFileAtomic = writeTextFileAtomic,
): Promise<void> {
  await writeAtomic(profileQuarantineJournalPath(profileDir), `${JSON.stringify(journal, undefined, 2)}\n`)
}

async function readJournal(profileDir: string): Promise<ProfileQuarantineJournal> {
  try {
    const parsed = JSON.parse(await readFile(profileQuarantineJournalPath(profileDir), 'utf8')) as Partial<ProfileQuarantineJournal>
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records : [] }
  } catch {
    return { version: 1, records: [] }
  }
}
