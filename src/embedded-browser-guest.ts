export const EMBEDDED_BROWSER_PAGE_PARTITION = 'persist:dsh-browser'
export const EMBEDDED_BROWSER_CHROME_PARTITION = 'persist:dsh-browser-chrome'

export type EmbeddedBrowserGuestKind = 'chrome' | 'page' | 'reject'

/** The DSH renderer may host webviews, but only these two browser surfaces. */
export function classifyEmbeddedBrowserGuest(
  source: unknown,
  partition: unknown,
  chromeUrl: string,
): EmbeddedBrowserGuestKind {
  if (typeof source !== 'string' || typeof partition !== 'string') return 'reject'
  if (source === chromeUrl && partition === EMBEDDED_BROWSER_CHROME_PARTITION) return 'chrome'
  if (partition !== EMBEDDED_BROWSER_PAGE_PARTITION) return 'reject'
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:' ? 'page' : 'reject'
  } catch {
    return 'reject'
  }
}
