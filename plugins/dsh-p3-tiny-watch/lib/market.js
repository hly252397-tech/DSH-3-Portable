import { randomUUID } from 'node:crypto'
import { dedupeListings, evaluateAlerts, normalizeListing, summarizeListings } from './core.js'
import { collectFromSources } from './sources.js'

export class P3TinyMonitor {
  constructor(options) {
    this.store = options.store
    this.config = options.config
    this.logger = options.logger ?? console
    this.notify = options.notify ?? (() => undefined)
    this.notifyRun = options.notifyRun ?? (() => undefined)
    this.running = undefined
  }

  async check(trigger = 'manual', signal = undefined) {
    if (this.running) return this.running
    const task = this.#run(trigger, signal).finally(() => { this.running = undefined })
    this.running = task
    return task
  }

  async #run(trigger, signal) {
    const startedAt = new Date().toISOString()
    const runId = randomUUID()
    const state = await this.store.load()
    const collected = await collectFromSources(this.config.sourceUrls, {
      allowlist: this.config.sourceAllowlist,
      maxBytes: this.config.maxResponseBytes,
      retries: this.config.retryCount,
      signal,
      timeoutMs: this.config.timeoutMs,
      userAgent: this.config.userAgent,
    })
    const normalized = dedupeListings(collected.listings
      .map(item => normalizeListing(item, { rates: this.config.currencyRates }))
      .filter(Boolean))
      .slice(0, this.config.maxResultsPerRun)
    const result = evaluateAlerts(normalized, state, {
      thresholdCny: this.config.thresholdCny,
      minimumConfidence: this.config.minimumConfidence,
      includeDamaged: this.config.includeDamaged,
      batchDiscountRatio: this.config.batchDiscountRatio,
      priceDropRatio: this.config.priceDropRatio,
    })
    const summary = summarizeListings(normalized, this.config.thresholdCny)
    const run = {
      runId,
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      sourceCount: this.config.sourceUrls.length,
      sampleCount: normalized.length,
      trustedCount: result.trusted.length,
      alertCount: result.alerts.length,
      minimumCny: summary.minimumCny,
      medianCny: summary.medianCny,
      errors: collected.errors,
      status: collected.errors.length === this.config.sourceUrls.length ? 'failed' : collected.errors.length ? 'partial' : 'success',
    }
    await this.store.recordRun(run, normalized, result.alerts)
    for (const alert of result.alerts) {
      try { await this.notify(alert, run) } catch (error) { this.logger.warn?.('P3 Tiny 提醒发送失败：', error) }
    }
    if (!result.alerts.length && this.config.notifyOnlyOnMatch === false) {
      try { await this.notifyRun(run, summary) } catch (error) { this.logger.warn?.('P3 Tiny 检查通知发送失败：', error) }
    }
    return { run, listings: normalized, alerts: result.alerts, summary }
  }

  async status() {
    const state = await this.store.load()
    const listings = Object.values(state.listings ?? {})
    return {
      state,
      summary: summarizeListings(listings, this.config.thresholdCny),
    }
  }
}
