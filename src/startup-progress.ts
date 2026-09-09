export const STARTUP_PROGRESS = {
  boot: 5,
  firstLaunchPreparation: 10,
  runtimeExtractionStarted: 15,
  runtimeReady: 45,
  pluginStorePreparationStarted: 50,
  pluginStoreReady: 70,
  workspacePreparation: 74,
  bundledPluginsReady: 80,
  profileUpdatesApplied: 84,
  profileReady: 88,
  dshStarting: 90,
  dshReady: 97,
  complete: 100,
} as const

export function advanceStartupProgress(current: number, candidate: number): number {
  const normalizedCurrent = normalizePercentage(current)
  const normalizedCandidate = normalizePercentage(candidate)
  return Math.max(normalizedCurrent, normalizedCandidate)
}

function normalizePercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}
