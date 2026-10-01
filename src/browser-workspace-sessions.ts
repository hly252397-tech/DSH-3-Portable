export interface SavedBrowserTab {
  id: string
  title: string
  url: string
}

export interface SavedBrowserSession {
  activeTabId: string | null
  tabs: SavedBrowserTab[]
}

/** Treat a portable workspace file as data, never as trusted browser commands. */
export function normalizeSavedBrowserTabs(value: unknown, limit = 12): SavedBrowserTab[] {
  if (!Array.isArray(value)) return []
  const tabs: SavedBrowserTab[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (typeof row !== 'object' || row === null) continue
    const candidate = row as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 100 || seen.has(candidate.id)) continue
    if (typeof candidate.url !== 'string') continue
    try {
      const url = new URL(candidate.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      tabs.push({ id: candidate.id, url: url.href, title: typeof candidate.title === 'string' ? candidate.title.slice(0, 512) : url.href })
      seen.add(candidate.id)
      if (tabs.length >= limit) break
    } catch { /* malformed legacy URL */ }
  }
  return tabs
}

export function normalizeSavedBrowserSessions(value: unknown): Map<string, SavedBrowserSession> {
  const sessions = new Map<string, SavedBrowserSession>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return sessions
  for (const [sessionId, raw] of Object.entries(value)) {
    if (sessionId.length === 0 || sessionId.length > 300 || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const candidate = raw as Record<string, unknown>
    const tabs = normalizeSavedBrowserTabs(candidate.tabs)
    const requested = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null
    sessions.set(sessionId, { tabs, activeTabId: tabs.some(tab => tab.id === requested) ? requested : tabs[0]?.id ?? null })
  }
  return sessions
}
