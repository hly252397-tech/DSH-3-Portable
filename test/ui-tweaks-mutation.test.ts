import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

for (const relative of ['customizations/ui-tweaks/lib/client.js', 'Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js']) {
  test(`UI tweaks settles DOM mutations and restores removed style: ${relative}`, t => {
    const file = resolve(relative)
    if (!existsSync(file)) return t.skip('Optional live Profile is not installed')
    const elements = new Map<string, FakeElement>()
    const observers: Array<() => void> = []
    let pending = false
    let textWrites = 0
    class FakeElement {
      id = ''
      className = ''
      private text = ''
      get textContent(): string { return this.text }
      set textContent(value: string) {
        this.text = value
        textWrites += 1
        pending = true // DOM replacement notifies even when text is identical.
      }
      appendChild(child: FakeElement): void { elements.set(child.id, child); pending = true }
    }
    const document = {
      readyState: 'complete',
      documentElement: { dataset: {} },
      head: new FakeElement(), body: new FakeElement(),
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new FakeElement(),
      querySelector: () => null,
      addEventListener: () => {},
    }
    let plugin: { apply(ctx: unknown): void } | undefined
    const window = {
      addEventListener: () => {},
      __ModuleLoader__: { load: (registration: { factory(): { apply(): void } }) => { plugin = registration.factory() } },
    }
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      window, document,
      MutationObserver: class {
        constructor(private readonly callback: () => void) {}
        observe(): void { observers.push(this.callback) }
      },
      fetch: async () => ({ ok: false }),
      setInterval: () => 0, setTimeout: () => 0,
    })
    assert.ok(plugin)
    // This fixture isolates the existing composer/style observer. The separate
    // settings-icons test executes the new ctx-owned effect and its teardown.
    plugin.apply({ effect: () => () => {} })
    const settle = (): number => {
      let rounds = 0
      while (pending && rounds < 20) {
        pending = false
        rounds += 1
        for (const callback of observers) callback()
      }
      assert.equal(pending, false, 'Style mutation must not recursively feed its observer')
      return rounds
    }
    assert.equal(settle(), 1)
    const original = elements.get('dsh-ui-tweaks-style')?.textContent
    assert.ok(original && original.length > 0)
    assert.equal(textWrites, 1, 'Startup and observer must reuse identical style text')
    pending = true // Unrelated application render must still be observed.
    assert.equal(settle(), 1)
    assert.equal(textWrites, 1)
    elements.delete('dsh-ui-tweaks-style')
    pending = true
    assert.equal(settle(), 2)
    assert.equal(textWrites, 2)
    assert.equal(elements.get('dsh-ui-tweaks-style')?.textContent, original)
  })
}
