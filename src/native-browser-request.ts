/** The card may open web pages; browser data management stays in the browser renderer. */
export function normalizeNativeBrowserRequest(value: unknown, selfOrigin: string): { owner: string; url?: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid browser card request')
  const request = value as { owner?: unknown; url?: unknown }
  if (typeof request.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.owner)) throw new Error('Invalid browser card owner')
  if (request.url === undefined || request.url === '') return { owner: request.owner }
  if (typeof request.url !== 'string' || request.url.length > 8192) throw new Error('Invalid browser URL')
  let url: URL
  try { url = new URL(request.url) } catch { throw new Error('Invalid browser URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === selfOrigin || url.username || url.password) throw new Error('Browser card only accepts external HTTP(S) pages')
  return { owner: request.owner, url: url.href }
}
