/** The card may open web pages; browser data management stays in the browser renderer. */
export function normalizeNativeBrowserRequest(value: unknown, selfOrigin: string): { owner: string; url?: string; pageToken?: string; sessionId?: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid browser card request')
  const request = value as { owner?: unknown; url?: unknown; pageToken?: unknown; sessionId?: unknown }
  if (typeof request.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.owner)) throw new Error('Invalid browser card owner')
  // 页面实例令牌（可选，补丁 1）：由页面侧包装 browserPanel.show 时附上，用于拒绝迟到 IPC。
  // 旧客户端不带该字段 ⇒ 保持兼容（undefined 表示"无令牌"）。
  const pageToken = typeof request.pageToken === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(request.pageToken) ? request.pageToken : undefined
  // 调用方所属会话（可选，2026-09-21 用户令「别的会话不要自动给我开面板」）：
  // 由页面侧包装 show 时附上当前活动会话；外壳据此要求"只有当前会话能打开面板"。
  const sessionId = typeof request.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(request.sessionId) ? request.sessionId : undefined
  const base = { owner: request.owner, ...(pageToken === undefined ? {} : { pageToken }), ...(sessionId === undefined ? {} : { sessionId }) }
  if (request.url === undefined || request.url === '') return base
  if (typeof request.url !== 'string' || request.url.length > 8192) throw new Error('Invalid browser URL')
  let url: URL
  try { url = new URL(request.url) } catch { throw new Error('Invalid browser URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === selfOrigin || url.username || url.password) throw new Error('Browser card only accepts external HTTP(S) pages')
  return { ...base, url: url.href }
}
