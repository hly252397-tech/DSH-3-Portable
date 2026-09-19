import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from 'schemastery'

import { P3TinyMonitor } from './market.js'
import { WatchStore } from './storage.js'

export const name = 'dsh-p3-tiny-watch'
export const inject = ['commands']

const DEFAULT_SOURCES = [
  'https://www.ebay.com/sch/i.html?_nkw=Lenovo+ThinkStation+P3+Tiny&_sop=15',
  'https://www.ebay.co.uk/sch/i.html?_nkw=Lenovo+ThinkStation+P3+Tiny&_sop=15',
]

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  thresholdCny: Schema.number().default(1500),
  scheduleEnabled: Schema.boolean().default(true),
  checkIntervalHours: Schema.number().default(168),
  startupDelaySeconds: Schema.number().default(45),
  notifyOnlyOnMatch: Schema.boolean().default(true),
  desktopNotifications: Schema.boolean().default(true),
  maxResultsPerRun: Schema.number().default(30),
  historyRetentionDays: Schema.number().default(365),
  timeoutMs: Schema.number().default(30000),
  retryCount: Schema.number().default(1),
  maxResponseBytes: Schema.number().default(5000000),
  minimumConfidence: Schema.number().default(0.65),
  includeDamaged: Schema.boolean().default(false),
  batchDiscountRatio: Schema.number().default(0.7),
  priceDropRatio: Schema.number().default(0.9),
  sourceUrls: Schema.array(Schema.string()).default(DEFAULT_SOURCES),
  sourceAllowlist: Schema.array(Schema.string()).default(['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr']),
  currencyRates: Schema.object({
    CNY: Schema.number().default(1),
    USD: Schema.number().default(7.2),
    GBP: Schema.number().default(9.3),
    EUR: Schema.number().default(7.8),
    JPY: Schema.number().default(0.048),
    HKD: Schema.number().default(0.92),
    CAD: Schema.number().default(5.25),
    AUD: Schema.number().default(4.7),
  }),
  userAgent: Schema.string().default('DSH-P3-Tiny-Watch/0.1 (+local price monitor)'),
})

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const dataRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-data', name)
  const store = new WatchStore(dataRoot, { retentionDays: config.historyRetentionDays })
  const monitor = new P3TinyMonitor({
    store,
    config,
    logger: ctx.logger,
    notify: async (alert, run) => {
      ctx.emit?.('p3-tiny-watch/alert', alert, run)
      if (!config.desktopNotifications) return
      sendDesktopNotification(alert)
    },
    notifyRun: async (run, summary) => {
      ctx.emit?.('p3-tiny-watch/run', run, summary)
      if (!config.desktopNotifications) return
      sendRunNotification(run, summary)
    },
  })

  ctx.effect(() => ctx.commands.register({
    name: 'p3-tiny-check',
    description: '立即检查 Lenovo ThinkStation P3 Tiny 二手行情',
    input: { hint: '无需参数' },
    handler: async invocation => {
      if (!config.enabled) return commandError('P3 Tiny 监控已禁用。')
      const result = await monitor.check('command', invocation.signal)
      return commandSuccess(formatCheckResult(result, config.thresholdCny))
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'p3-tiny-status',
    description: '查看 P3 Tiny 监控状态和历史价格摘要',
    input: { hint: '无需参数' },
    handler: async () => {
      const { state, summary } = await monitor.status()
      return commandSuccess(formatStatus(state.lastRun, summary, config))
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'p3-tiny-list',
    description: '查看最近发现的 P3 Tiny 有效货源',
    input: { hint: '可选：显示数量，例如 10' },
    handler: async invocation => {
      const limit = parseLimit(invocation.rawInput, 10)
      const { state } = await monitor.status()
      const listings = Object.values(state.listings ?? {})
        .sort((a, b) => Date.parse(b.lastSeenAt ?? b.capturedAt) - Date.parse(a.lastSeenAt ?? a.capturedAt))
        .slice(0, limit)
      return commandSuccess(formatListings(listings))
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'p3-tiny-config',
    description: '查看 P3 Tiny 监控当前配置',
    input: { hint: '无需参数' },
    handler: () => commandSuccess(formatConfig(config, dataRoot)),
  }))

  if (config.enabled && config.scheduleEnabled) installSchedule(ctx, monitor, config)
}

function installSchedule(ctx, monitor, config) {
  if (typeof ctx.interval !== 'function' || typeof ctx.timeout !== 'function') {
    ctx.logger?.warn?.('dsh-p3-tiny-watch：当前组合未提供 timer 服务，已保留手动检查命令。')
    return
  }
  const intervalMs = Math.max(1, config.checkIntervalHours) * 3_600_000
  const runIfDue = async () => {
    try {
      const { state } = await monitor.status()
      const last = Date.parse(state.lastRun?.completedAt ?? state.lastRun?.startedAt ?? '')
      if (Number.isFinite(last) && Date.now() - last < intervalMs) return
      await monitor.check('schedule')
    } catch (error) {
      ctx.logger?.warn?.('dsh-p3-tiny-watch 自动检查失败：', error)
    }
  }
  ctx.timeout(() => { void runIfDue() }, Math.max(1, config.startupDelaySeconds) * 1000)
  ctx.interval(() => { void runIfDue() }, Math.min(intervalMs, 3_600_000))
}

function normalizeConfig(value) {
  const config = {
    enabled: value.enabled !== false,
    thresholdCny: boundedNumber(value.thresholdCny, 1500, 1, 1_000_000),
    scheduleEnabled: value.scheduleEnabled !== false,
    checkIntervalHours: boundedNumber(value.checkIntervalHours, 168, 1, 24 * 365),
    startupDelaySeconds: boundedNumber(value.startupDelaySeconds, 45, 1, 3600),
    notifyOnlyOnMatch: value.notifyOnlyOnMatch !== false,
    desktopNotifications: value.desktopNotifications !== false,
    maxResultsPerRun: Math.round(boundedNumber(value.maxResultsPerRun, 30, 1, 500)),
    historyRetentionDays: Math.round(boundedNumber(value.historyRetentionDays, 365, 1, 3650)),
    timeoutMs: Math.round(boundedNumber(value.timeoutMs, 30000, 1000, 120000)),
    retryCount: Math.round(boundedNumber(value.retryCount, 1, 0, 2)),
    maxResponseBytes: Math.round(boundedNumber(value.maxResponseBytes, 5_000_000, 10_000, 20_000_000)),
    minimumConfidence: boundedNumber(value.minimumConfidence, 0.65, 0, 1),
    includeDamaged: value.includeDamaged === true,
    batchDiscountRatio: boundedNumber(value.batchDiscountRatio, 0.7, 0.1, 1),
    priceDropRatio: boundedNumber(value.priceDropRatio, 0.9, 0.1, 1),
    sourceUrls: normalizeStringArray(value.sourceUrls, DEFAULT_SOURCES, 20),
    sourceAllowlist: normalizeStringArray(value.sourceAllowlist, ['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr'], 50),
    currencyRates: normalizeRates(value.currencyRates),
    userAgent: String(value.userAgent || 'DSH-P3-Tiny-Watch/0.1 (+local price monitor)').slice(0, 240),
  }
  if (!config.sourceUrls.length) throw new Error('dsh-p3-tiny-watch：sourceUrls 不能为空。')
  return config
}

function normalizeRates(value) {
  const defaults = { CNY: 1, USD: 7.2, GBP: 9.3, EUR: 7.8, JPY: 0.048, HKD: 0.92, CAD: 5.25, AUD: 4.7 }
  const output = { ...defaults }
  for (const code of Object.keys(defaults)) {
    const number = Number(value?.[code])
    if (Number.isFinite(number) && number > 0 && number < 1000) output[code] = number
  }
  return output
}

function normalizeStringArray(value, fallback, maximum) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.map(item => String(item).trim()).filter(Boolean))].slice(0, maximum)
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function formatCheckResult(result, thresholdCny) {
  const lines = [
    `P3 Tiny 行情检查：${result.run.status === 'success' ? '成功' : result.run.status === 'partial' ? '部分成功' : '失败'}`,
    `样本 ${result.summary.total} 条，可信 ${result.summary.trusted} 条，低于 ¥${thresholdCny} 的可信货源 ${result.summary.belowThreshold} 条。`,
    `最低可信单价：${money(result.summary.minimumCny)}；中位价：${money(result.summary.medianCny)}。`,
    `本次提醒：${result.alerts.length} 条。`,
  ]
  if (result.run.errors.length) {
    lines.push('来源错误：')
    for (const error of result.run.errors.slice(0, 5)) lines.push(`- ${error.code}: ${error.message}`)
  }
  if (result.alerts.length) {
    lines.push('', '命中货源：')
    for (const alert of result.alerts.slice(0, 10)) {
      lines.push(formatAlertLine(alert))
    }
  }
  return lines.join('\n')
}

function formatStatus(lastRun, summary, config) {
  return [
    'P3 Tiny 监控状态',
    `启用：${config.enabled ? '是' : '否'}；自动检查：${config.scheduleEnabled ? `每 ${config.checkIntervalHours} 小时` : '关闭'}`,
    `目标价：¥${config.thresholdCny}`,
    `最近检查：${lastRun?.completedAt ?? '尚未检查'}`,
    `最近状态：${lastRun?.status ?? '无'}`,
    `历史货源：${summary.total} 条；可信 ${summary.trusted} 条；目标价内 ${summary.belowThreshold} 条`,
    `最低可信单价：${money(summary.minimumCny)}；中位价：${money(summary.medianCny)}`,
    `最近错误：${lastRun?.errors?.length ? lastRun.errors.map(item => `${item.code}:${item.message}`).join('；') : '无'}`,
  ].join('\n')
}

function formatListings(listings) {
  if (!listings.length) return '暂无 P3 Tiny 货源记录。请先执行 /p3-tiny-check。'
  return listings.map((item, index) => {
    const flags = item.flags?.length ? ` [${item.flags.join(', ')}]` : ''
    return `${index + 1}. ${item.title}\n   ${money(item.unitCny)} / ${item.currency ?? '?'} ${item.totalOriginal ?? '?'}；${item.cpu ?? 'CPU未知'}；${item.url}${flags}`
  }).join('\n')
}

function formatConfig(config, dataRoot) {
  return [
    'P3 Tiny 监控配置',
    `目标价：¥${config.thresholdCny}`,
    `周期：${config.scheduleEnabled ? `${config.checkIntervalHours} 小时` : '关闭'}`,
    `来源：${config.sourceUrls.join('；')}`,
    `域名允许列表：${config.sourceAllowlist.join(', ')}`,
    `单次最大结果：${config.maxResultsPerRun}`,
    `最低可信度：${config.minimumConfidence}`,
    `包含损坏/未测试机器：${config.includeDamaged ? '是' : '否'}`,
    `数据目录：${dataRoot}`,
    '汇率为可配置估算值，购买前必须人工确认实时汇率、运费、税费、成色和缺件。',
  ].join('\n')
}

function sendDesktopNotification(alert) {
  if (typeof process.send !== 'function') return
  const listing = alert.listing
  const body = [
    `${money(listing.unitCny)} · ${listing.cpu ?? 'CPU未知'} · ${listing.title}`,
    alert.reasons.join('；'),
    alert.requiresManualReview ? '需要人工确认成色与缺件。' : '购买前仍需人工核对卖家和配置。',
  ].join('\n').slice(0, 500)
  try {
    process.send({
      type: 'notify',
      kind: 'turn-complete',
      sessionId: 'dsh-p3-tiny-watch',
      title: 'P3 Tiny 抄底提醒',
      body,
    })
  } catch {
    // DSH may run without the desktop IPC host (for example in CLI tests).
  }
}

function sendRunNotification(run, summary) {
  if (typeof process.send !== 'function') return
  try {
    process.send({
      type: 'notify',
      kind: 'turn-complete',
      sessionId: 'dsh-p3-tiny-watch',
      title: 'P3 Tiny 行情检查完成',
      body: `状态：${run.status}；可信货源 ${summary.trusted} 条；最低 ${money(summary.minimumCny)}；本次没有新提醒。`.slice(0, 500),
    })
  } catch {
    // CLI or tests may not have the desktop IPC host.
  }
}

function formatAlertLine(alert) {
  const listing = alert.listing
  return `- ${money(listing.unitCny)} | ${listing.cpu ?? 'CPU未知'} | ${listing.title}\n  ${listing.url}\n  原因：${alert.reasons.join('；')}${alert.requiresManualReview ? '；需要人工确认' : ''}`
}

function money(value) {
  return Number.isFinite(value) ? `¥${Number(value).toFixed(2)}` : '未知'
}

function parseLimit(value, fallback) {
  const number = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(number) ? Math.max(1, Math.min(50, number)) : fallback
}

function commandSuccess(text) {
  return { kind: 'success', text }
}

function commandError(text) {
  return { kind: 'error', text }
}
