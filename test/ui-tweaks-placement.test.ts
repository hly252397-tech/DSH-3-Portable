import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

for (const withBilling of [false, true]) test(`UI toolbar placement settles and preserves shared controls (billing=${withBilling})`, () => {
  const source = readFileSync(process.env.DSH_PLACEMENT_TEST_SOURCE ?? 'customizations/ui-tweaks/lib/client.js', 'utf8')
  let pending = false
  let fits = withBilling
  let billingReady = false
  let moves = 0
  const observers: Array<() => void> = []
  const events = new Map<string, () => void>()
  const styles = new Map<string, Element>()
  class Element {
    id = ''
    className = ''
    textContent = ''
    children: Element[] = []
    parentElement: Element | null = null
    isConnected = true
    attributes = new Map<string, string>()
    classes = new Set<string>()
    classList = {
      add: (name: string) => { this.classes.add(name) },
      remove: (name: string) => { this.classes.delete(name) },
      contains: (name: string) => this.classes.has(name) || this.className === name,
    }
    style = { removeProperty: () => {}, setProperty: () => {} }
    get nextElementSibling(): Element | null {
      const peers = this.parentElement?.children ?? []
      return peers[peers.indexOf(this) + 1] ?? null
    }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
    removeAttribute(name: string): void { this.attributes.delete(name) }
    appendChild(el: Element): void { this.insertBefore(el, null) }
    insertBefore(el: Element, next: Element | null): void {
      if (el.parentElement) el.parentElement.children.splice(el.parentElement.children.indexOf(el), 1)
      const index = next ? this.children.indexOf(next) : -1
      this.children.splice(index < 0 ? this.children.length : index, 0, el)
      el.parentElement = this
      if (el.id) styles.set(el.id, el)
      pending = true
      if (el === model) moves += 1
    }
    remove(): void {
      if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1)
      this.parentElement = null
      pending = true
    }
    closest(): null { return null }
    querySelector(selector: string): Element | null {
      if (withBilling && billingReady && this === trailing && selector === '[aria-label^="本轮 "]') return chip
      return null
    }
    querySelectorAll(): Element[] { return [] }
    contains(el: Element): boolean { return this.children.some(child => child === el || child.contains(el)) }
    getBoundingClientRect() {
      const lifted = this === model && this.parentElement?.className === 'dsh-tweaks-seat'
      const width = this === model ? lifted && !fits ? 0 : 90
        : this === controls && !this.contains(model) ? 0 : this === chip ? 24 : 300
      return { left: 0, right: width, top: 20, bottom: 52, width, height: lifted && !fits ? 0 : 32 }
    }
  }
  const model = new Element()
  model.textContent = 'Test model'
  const origin = new Element()
  origin.appendChild(model)
  const chip = new Element()
  chip.textContent = '平价'
  const controls = new Element()
  controls.appendChild(origin)
  const rightSlot = new Element()
  controls.appendChild(rightSlot)
  rightSlot.appendChild(chip)
  const trailing = new Element()
  trailing.appendChild(controls)
  const dock = new Element()
  const stack = new Element()
  stack.appendChild(dock)
  const document = {
    readyState: 'complete', documentElement: { dataset: {} }, head: new Element(), body: new Element(),
    getElementById: (id: string) => styles.get(id) ?? null,
    createElement: () => new Element(), addEventListener: () => {}, querySelectorAll: () => [],
    querySelector: (selector: string) => selector === '.dbh-dock' ? dock : selector === '._7KE1Ra_root' ? model
      : withBilling && billingReady && selector === '[data-testid="billing-live-cost-chip"]' ? chip
      : withBilling && selector === '.uV2eYG_trailing' ? trailing : null,
  }
  let plugin: { apply(ctx: unknown): void } | undefined
  const window = {
    innerWidth: 1360, innerHeight: 856,
    __dshTweaksBrandClick: true, __dshTweaksRailTip: true, __dshWidthProbe: true,
    addEventListener: (name: string, cb: () => void) => events.set(name, cb),
    __ModuleLoader__: { load: (registration: { factory(): { apply(ctx: unknown): void } }) => { plugin = registration.factory() } },
  }
  vm.runInNewContext(source, {
    window, document, Element, getComputedStyle: () => ({ position: 'static' }),
    MutationObserver: class { constructor(private callback: () => void) {} observe(): void { observers.push(this.callback) } },
    setInterval: () => 0, setTimeout: () => 0, fetch: async () => ({ ok: false }),
  })
  const settle = () => {
    for (let round = 0; pending && round < 20; round++) {
      pending = false
      for (const callback of observers) callback()
    }
    assert.equal(pending, false, 'Rejected placement must not continually move and restore the same model')
  }
  assert.ok(plugin)
  // This fixture isolates the composer; settings effect has its own DOM/lifecycle tests.
  plugin.apply({ effect: () => () => {} })
  settle()
  if (withBilling) {
    assert.equal(dock.contains(model), true, 'Model can mount before billing')
    billingReady = true
    pending = true
    settle()
    assert.equal(dock.contains(model), true, 'Initial layout must not be rejected because its shared wrapper became empty')
    assert.equal(dock.contains(chip), true, 'Only the billing chip moves alongside the model')
    assert.equal(controls.parentElement, trailing, 'Shared controls and model slot stay owned by the composer')
    assert.equal(origin.parentElement, controls)
    assert.match(source, /\.dsh-tweaks-seat>\.dsh-tweaks-model\{order:2!important\}/, 'Model remains rightmost even when billing arrives later')
    const successfulMoves = moves
    pending = true
    settle()
    assert.equal(moves, successfulMoves)
    return
  }
  assert.equal(model.parentElement, origin, 'Rejected model is restored to its original interactive location')
  assert.equal(model.classList.contains('dsh-tweaks-model'), false, 'Rejected model must retain its normal label')
  const rejectedMoves = moves
  pending = true
  settle()
  assert.equal(moves, rejectedMoves, 'Unrelated DOM changes must not retry identical rejected geometry')
  fits = true
  window.innerWidth = 1600
  events.get('resize')?.()
  settle()
  assert.equal(dock.contains(model), true, 'A real layout change retries and can place the model')
  const successfulMoves = moves
  pending = true
  settle()
  assert.equal(moves, successfulMoves, 'Successful placement is also stable')
})
