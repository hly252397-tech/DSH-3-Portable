import { createHash } from 'node:crypto'

export interface HarnessReleaseSource {
  readonly owner: string
  readonly repo: string
}

/** This is the portable project's release authority, not the desktop upstream. */
export const DEFAULT_HARNESS_RELEASE_SOURCE: HarnessReleaseSource = {
  owner: 'hly252397-tech',
  repo: 'DSH-3-Portable',
}

export const MAX_HARNESS_ARCHIVE_BYTES = 1_500_000_000
export const MAX_HARNESS_UNPACKED_BYTES = 8 * 1024 ** 3

export interface HarnessReleaseContract {
  readonly schema: 1
  readonly component: 'harness'
  readonly version: string
  readonly platform: 'win32'
  readonly arch: 'x64'
  readonly nodeVersion: string
  readonly artifact: string
  readonly size: number
  readonly unpackedSize: number
  readonly sha256: string
  readonly contentSha256: string
  readonly npmIntegrity: string
  readonly officialCommit: string
  readonly runtimeFingerprint: string
  readonly profileCompatibility?: Readonly<Record<string, readonly string[]>>
  readonly dataCompatibilityGroup?: string
}

export interface HarnessPrebuiltRelease extends HarnessReleaseContract {
  readonly source: HarnessReleaseSource
  readonly releaseTag: string
  readonly assetUrl: string
}

export class HarnessReleaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HarnessReleaseError'
  }
}

export function harnessReleaseNames(version: string): { tag: string; artifact: string; contract: string } {
  assertVersion(version)
  return {
    tag: `harness-v${version}`,
    artifact: `dsh-harness-${version}-win-x64.tgz`,
    contract: `dsh-harness-contract-${version}-win-x64.json`,
  }
}

export function normalizeHarnessNodeVersion(value: string): string {
  const version = value.replace(/^v/, '')
  if (version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new HarnessReleaseError('NODE_VERSION', 'DSH 预构建包需要明确的 Node 版本。')
  }
  return version
}

/** Publisher-side identity distinguishes plain prebuilt trees from old pnpm-linked slots. */
export function stampHarnessPrebuiltLockfile(lock: string, nodeVersion: string): string {
  const node = normalizeHarnessNodeVersion(nodeVersion)
  let body = lock
  while (/^# dsh-harness-prebuilt-(?:format|node):[^\r\n]*\r?\n/.test(body)) {
    body = body.replace(/^# dsh-harness-prebuilt-(?:format|node):[^\r\n]*\r?\n/, '')
  }
  return `# dsh-harness-prebuilt-format: 1\n# dsh-harness-prebuilt-node: ${node}\n${body}`
}

function assertVersion(version: string): void {
  if (version.length > 128 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new HarnessReleaseError('VERSION', 'DSH 预构建版本格式无效。')
  }
}

function sourceValue(source: HarnessReleaseSource): HarnessReleaseSource {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(source.owner)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(source.repo)) {
    throw new HarnessReleaseError('SOURCE', 'DSH 预构建发布源无效。')
  }
  return { owner: source.owner, repo: source.repo }
}

export function parseHarnessReleaseContract(value: unknown, version: string, nodeVersion: string): HarnessReleaseContract {
  const names = harnessReleaseNames(version)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessReleaseError('CONTRACT', 'DSH 预构建契约不是有效对象。')
  }
  const row = value as Record<string, unknown>
  if (row.schema !== 1 || row.component !== 'harness' || row.version !== version
    || row.platform !== 'win32' || row.arch !== 'x64' || row.artifact !== names.artifact) {
    throw new HarnessReleaseError('CONTRACT', 'DSH 预构建契约的组件、版本、平台或制品名称不匹配。')
  }
  if (row.nodeVersion !== normalizeHarnessNodeVersion(nodeVersion)) {
    throw new HarnessReleaseError('NODE_INCOMPATIBLE', 'DSH 预构建包的 Node 版本与当前桌面运行环境不匹配。')
  }
  for (const key of ['sha256', 'contentSha256', 'runtimeFingerprint'] as const) {
    if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/i.test(row[key])) {
      throw new HarnessReleaseError('CONTRACT_HASH', 'DSH 预构建契约缺少合法 SHA256 或运行时指纹。')
    }
  }
  if (!isIntegrity(row.npmIntegrity) || typeof row.officialCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(row.officialCommit)) {
    throw new HarnessReleaseError('PROVENANCE', 'DSH 预构建契约缺少官方 npm integrity 或 commit。')
  }
  if (!Number.isSafeInteger(row.size) || Number(row.size) < 1_024 || Number(row.size) > MAX_HARNESS_ARCHIVE_BYTES
    || !Number.isSafeInteger(row.unpackedSize) || Number(row.unpackedSize) < 1 || Number(row.unpackedSize) > MAX_HARNESS_UNPACKED_BYTES) {
    throw new HarnessReleaseError('SIZE', 'DSH 预构建包大小超出允许范围。')
  }
  const profileCompatibility: Record<string, readonly string[]> = Object.create(null)
  if (row.profileCompatibility !== undefined) {
    if (!isRecord(row.profileCompatibility) || Object.keys(row.profileCompatibility).length > 256) {
      throw new HarnessReleaseError('PROFILE_COMPATIBILITY', 'DSH 插件兼容授权清单无效或过大。')
    }
    for (const [key, versions] of Object.entries(row.profileCompatibility)) {
      if (key.length > 256 || !/^(?:@[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*|[a-z0-9][a-z0-9_.-]*)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(key)
        || !Array.isArray(versions) || versions.length !== 1 || versions[0] !== version) {
        throw new HarnessReleaseError('PROFILE_COMPATIBILITY', 'DSH 插件兼容授权必须精确绑定包版本和本次内核版本。')
      }
      profileCompatibility[key] = [version]
    }
  }
  if (row.dataCompatibilityGroup !== undefined && (typeof row.dataCompatibilityGroup !== 'string'
    || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(row.dataCompatibilityGroup))) {
    throw new HarnessReleaseError('DATA_COMPATIBILITY', 'DSH 数据兼容组标识无效。')
  }
  return {
    schema: 1, component: 'harness', version, platform: 'win32', arch: 'x64',
    nodeVersion: row.nodeVersion as string,
    artifact: names.artifact, size: row.size as number, unpackedSize: row.unpackedSize as number,
    sha256: (row.sha256 as string).toLowerCase(), contentSha256: (row.contentSha256 as string).toLowerCase(),
    npmIntegrity: row.npmIntegrity, officialCommit: row.officialCommit.toLowerCase(),
    runtimeFingerprint: (row.runtimeFingerprint as string).toLowerCase(),
    profileCompatibility,
    ...(row.dataCompatibilityGroup === undefined ? {} : { dataCompatibilityGroup: row.dataCompatibilityGroup as string }),
  }
}

/** Metadata may select an asset name, but may never choose a new download authority. */
export function trustedHarnessAssetUrl(value: string, source: HarnessReleaseSource, tag: string, artifact: string): string {
  const authority = sourceValue(source)
  let url: URL
  try { url = new URL(value) } catch { throw new HarnessReleaseError('ASSET_SOURCE', 'DSH 预构建制品地址无效。') }
  let parts: string[]
  try { parts = url.pathname.split('/').map(part => decodeURIComponent(part)) } catch {
    throw new HarnessReleaseError('ASSET_SOURCE', 'DSH 预构建制品地址编码无效。')
  }
  const expected = ['', authority.owner, authority.repo, 'releases', 'download', tag, artifact]
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' || url.username !== ''
    || url.password !== '' || url.search !== '' || url.hash !== '' || parts.length !== expected.length
    || parts.some((part, index) => part !== expected[index])) {
    throw new HarnessReleaseError('ASSET_SOURCE', 'DSH 预构建制品不属于配置的 GitHub 发布源。')
  }
  return url.toString()
}

/** GitHub redirects release assets to its signed CDN. No other redirect host is accepted. */
export async function fetchHarnessReleaseAsset(
  url: string, source: HarnessReleaseSource, tag: string, artifact: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch
  let next = trustedHarnessAssetUrl(url, source, tag, artifact)
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(next, { redirect: 'manual', signal: options.signal, headers: { 'User-Agent': 'DSH-3-Portable-Harness-Updater' } })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null) throw new HarnessReleaseError('ASSET_REDIRECT', 'DSH 制品重定向缺少地址。')
    const redirect = new URL(location, next)
    const trustedCdn = ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(redirect.hostname)
    if (redirect.protocol !== 'https:' || redirect.port !== '' || redirect.username !== '' || redirect.password !== ''
      || (!trustedCdn && redirect.toString() !== trustedHarnessAssetUrl(redirect.toString(), source, tag, artifact))) {
      throw new HarnessReleaseError('ASSET_REDIRECT', 'DSH 制品重定向离开了 GitHub 受信来源。')
    }
    next = redirect.toString()
  }
  throw new HarnessReleaseError('ASSET_REDIRECT', 'DSH 制品重定向次数超过上限。')
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) throw new HarnessReleaseError('EMPTY_RESPONSE', '更新服务没有返回数据。')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > limit) throw new HarnessReleaseError('METADATA_SIZE', '更新元数据超出允许大小。')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<{ status: number; value?: unknown }> {
  const response = await fetchImpl(url, {
    redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json', 'User-Agent': 'DSH-3-Portable-Harness-Updater' },
  })
  if (response.status === 404) { await response.body?.cancel(); return { status: 404 } }
  if (!response.ok) throw new HarnessReleaseError('METADATA_HTTP', `更新元数据返回 HTTP ${response.status}。`)
  try { return { status: response.status, value: JSON.parse((await readBoundedBody(response, 2 * 1024 * 1024)).toString('utf8')) } } catch (error) {
    if (error instanceof HarnessReleaseError) throw error
    throw new HarnessReleaseError('METADATA_JSON', '更新元数据不是有效 JSON。')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIntegrity(value: unknown): value is string {
  return typeof value === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)
    && Buffer.from(value.slice(7), 'base64').length === 64
}

export async function fetchOfficialHarnessProvenance(version: string, fetchImpl: typeof fetch = fetch): Promise<{ npmIntegrity: string; officialCommit: string }> {
  assertVersion(version)
  const registry = await fetchJson(fetchImpl, `https://registry.npmjs.org/@deepseek-ai%2Fdsh/${encodeURIComponent(version)}`)
  const pkg = registry.value
  if (!isRecord(pkg) || pkg.name !== '@deepseek-ai/dsh' || pkg.version !== version || !isRecord(pkg.dist)) {
    throw new HarnessReleaseError('NPM_METADATA', '官方 npm 未确认该 DSH 精确版本。')
  }
  const dist = pkg.dist
  const expectedTarball = `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`
  if (!isIntegrity(dist.integrity) || dist.tarball !== expectedTarball || !Array.isArray(dist.signatures)
    || !dist.signatures.some(signature => isRecord(signature) && typeof signature.keyid === 'string' && signature.keyid !== '')) {
    throw new HarnessReleaseError('NPM_PROVENANCE', '官方 npm integrity、制品来源或 registry 签名声明不完整。')
  }
  const reference = await fetchJson(fetchImpl, `https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/${encodeURIComponent(`dsh-v${version}`)}`)
  let object = isRecord(reference.value) ? reference.value.object : undefined
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(object) || typeof object.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(object.sha)) break
    if (object.type === 'commit') return { npmIntegrity: dist.integrity, officialCommit: object.sha.toLowerCase() }
    if (object.type !== 'tag') break
    const annotated = await fetchJson(fetchImpl, `https://api.github.com/repos/deepseek-ai/deepseek-harness/git/tags/${object.sha}`)
    object = isRecord(annotated.value) ? annotated.value.object : undefined
  }
  throw new HarnessReleaseError('OFFICIAL_COMMIT', '官方 DSH 标签未解析为有效 commit。')
}

/** A missing independent release is explicit; it never triggers a local pnpm install. */
export async function fetchHarnessPrebuiltRelease(options: {
  version: string; nodeVersion: string; source?: HarnessReleaseSource; fetch?: typeof fetch
}): Promise<HarnessPrebuiltRelease | undefined> {
  const names = harnessReleaseNames(options.version)
  const source = sourceValue(options.source ?? DEFAULT_HARNESS_RELEASE_SOURCE)
  const fetchImpl = options.fetch ?? fetch
  const published = await fetchJson(fetchImpl, `https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/${encodeURIComponent(names.tag)}`)
  if (published.status === 404) return undefined
  const release = published.value
  if (!isRecord(release) || release.tag_name !== names.tag || release.draft === true || !Array.isArray(release.assets)) {
    throw new HarnessReleaseError('RELEASE', 'DSH 预构建发布标签或资产清单无效。')
  }
  const asset = release.assets.find(item => isRecord(item) && item.name === names.artifact)
  const contractAsset = release.assets.find(item => isRecord(item) && item.name === names.contract)
  if (!isRecord(asset) || !isRecord(contractAsset)) throw new HarnessReleaseError('ASSET_MISSING', 'DSH 独立发布缺少运行时包或兼容契约。')
  const assetDigest = asset.digest
  const contractDigest = contractAsset.digest
  if (typeof assetDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(assetDigest)
    || typeof contractDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(contractDigest)) {
    throw new HarnessReleaseError('ASSET_DIGEST', 'GitHub 没有提供 DSH 运行时包与契约的 SHA256。')
  }
  if (typeof asset.browser_download_url !== 'string' || typeof contractAsset.browser_download_url !== 'string'
    || !Number.isSafeInteger(contractAsset.size) || Number(contractAsset.size) < 64 || Number(contractAsset.size) > 64 * 1024) {
    throw new HarnessReleaseError('ASSET_METADATA', 'DSH 发布制品地址或契约大小无效。')
  }
  const assetUrl = trustedHarnessAssetUrl(asset.browser_download_url, source, names.tag, names.artifact)
  const response = await fetchHarnessReleaseAsset(contractAsset.browser_download_url, source, names.tag, names.contract, { fetch: fetchImpl, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new HarnessReleaseError('CONTRACT_HTTP', `DSH 兼容契约返回 HTTP ${response.status}。`)
  const bytes = await readBoundedBody(response, 64 * 1024)
  if (bytes.length !== contractAsset.size || createHash('sha256').update(bytes).digest('hex') !== contractDigest.slice(7).toLowerCase()) {
    throw new HarnessReleaseError('CONTRACT_DIGEST', 'DSH 兼容契约大小或 SHA256 不匹配。')
  }
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new HarnessReleaseError('CONTRACT_JSON', 'DSH 兼容契约不是有效 JSON。') }
  const contract = parseHarnessReleaseContract(parsed, options.version, options.nodeVersion)
  if (asset.size !== contract.size || assetDigest.slice(7).toLowerCase() !== contract.sha256) {
    throw new HarnessReleaseError('ASSET_CONTRACT', 'DSH 运行时包与发布契约不匹配。')
  }
  const official = await fetchOfficialHarnessProvenance(contract.version, fetchImpl)
  if (official.npmIntegrity !== contract.npmIntegrity || official.officialCommit !== contract.officialCommit) {
    throw new HarnessReleaseError('OFFICIAL_MISMATCH', 'DSH 预构建包的 npm integrity 或 commit 与官方发布不一致。')
  }
  return { ...contract, source, releaseTag: names.tag, assetUrl }
}
