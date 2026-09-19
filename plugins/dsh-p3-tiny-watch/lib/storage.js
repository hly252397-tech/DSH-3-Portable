import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const EMPTY_STATE = Object.freeze({
  schemaVersion: 1,
  lastRun: undefined,
  listings: {},
  alerts: {},
})

export class WatchStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir
    this.statePath = join(rootDir, 'state.json')
    this.runsPath = join(rootDir, 'runs.jsonl')
    this.listingsPath = join(rootDir, 'listings.jsonl')
    this.alertsPath = join(rootDir, 'alerts.jsonl')
    this.retentionDays = Number(options.retentionDays ?? 365)
  }

  async ensure() {
    await mkdir(this.rootDir, { recursive: true })
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'))
      return sanitizeState(parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      return structuredClone(EMPTY_STATE)
    }
  }

  async save(state) {
    await this.ensure()
    await atomicWriteJson(this.statePath, sanitizeState(state))
  }

  async recordRun(run, listings, alerts) {
    await this.ensure()
    const state = await this.load()
    const cutoff = Date.now() - Math.max(1, this.retentionDays) * 86_400_000
    const nextListings = {}
    for (const [key, value] of Object.entries(state.listings ?? {})) {
      const time = Date.parse(value.lastSeenAt ?? value.capturedAt ?? '')
      if (!Number.isFinite(time) || time >= cutoff) nextListings[key] = value
    }
    for (const listing of listings) {
      const previous = nextListings[listing.key]
      nextListings[listing.key] = {
        ...listing,
        firstSeenAt: previous?.firstSeenAt ?? listing.capturedAt,
        lastSeenAt: listing.capturedAt,
        seenCount: Number(previous?.seenCount ?? 0) + 1,
        priorUnitCny: previous?.unitCny,
      }
    }
    const nextAlerts = { ...(state.alerts ?? {}) }
    for (const alert of alerts) {
      nextAlerts[alert.key] = {
        unitCny: alert.listing.unitCny,
        createdAt: alert.createdAt,
        reasons: alert.reasons,
      }
    }
    const next = {
      schemaVersion: 1,
      lastRun: run,
      listings: nextListings,
      alerts: nextAlerts,
    }
    await this.save(next)
    await Promise.all([
      appendJsonLines(this.runsPath, [run]),
      appendJsonLines(this.listingsPath, listings),
      appendJsonLines(this.alertsPath, alerts),
    ])
    return next
  }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function appendJsonLine(path, value) {
  return appendJsonLines(path, [value])
}

export async function appendJsonLines(path, values) {
  if (!values.length) return
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(values.map(value => `${JSON.stringify(value)}\n`).join(''), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function sanitizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE)
  return {
    schemaVersion: 1,
    lastRun: value.lastRun && typeof value.lastRun === 'object' ? value.lastRun : undefined,
    listings: isRecord(value.listings) ? value.listings : {},
    alerts: isRecord(value.alerts) ? value.alerts : {},
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
