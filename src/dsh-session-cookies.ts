export const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-'

export interface DshCookieJar {
  get(filter: { url: string }): Promise<readonly { name: string }[]>
  remove(url: string, name: string): Promise<void>
}

/**
 * DSH binds each authentication cookie to the loopback host and ephemeral
 * port, while browser cookies themselves are shared across ports. Resolve the
 * narrow cookie scope that is safe for the desktop host to maintain.
 */
export function dshLoopbackCookieUrl(serverUrl: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    return undefined
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) return undefined
  return `${parsed.protocol}//${parsed.host}/`
}

/** Remove only stale DSH authentication cookies before exchanging a new launch token. */
export async function clearStaleDshAuthCookies(cookieJar: DshCookieJar, serverUrl: string): Promise<number> {
  const cookieUrl = dshLoopbackCookieUrl(serverUrl)
  if (cookieUrl === undefined) return 0
  const staleCookies = (await cookieJar.get({ url: cookieUrl }))
    .filter(cookie => cookie.name.startsWith(DSH_AUTH_COOKIE_PREFIX))
  for (const cookie of staleCookies) await cookieJar.remove(cookieUrl, cookie.name)
  return staleCookies.length
}
