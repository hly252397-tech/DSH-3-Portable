interface DesktopNavigationState {
  canBack: boolean
  canForward: boolean
  canNextChat: boolean
  canPreviousChat: boolean
}

interface SessionList {
  ids: string[]
  byId: Record<string, {
    completed?: boolean
    displayTitle: string
    origin?: string
    pendingInteraction?: 'approval' | 'plan-review' | 'question'
    running: boolean
    retainedBy?: { mainView?: number }
  }>
  current?: string
}

interface ClientContext {
  slots?: {
    inject(name: string, callback: () => unknown): void
    register(options: Record<string, unknown>, component: (props: { close?: () => void }) => unknown): unknown
  }
  effect(callback: () => void | (() => void), label?: string): void
  layout: { toggleSidebar(): void }
  uiWorkspace?: { openSession(id: string): void }
  locale: {
    getSnapshot(): { active: string }
    subscribe(listener: () => void): () => void
    register?(name: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind?(name: string): (key: string) => string
  }
  sessions: {
    binding(id: string): {
      session: {
        getSnapshot(): {
          nodes: Array<{
            kind: string
            blocks?: Array<{ kind: string; text?: string }>
          }>
        }
      }
    } | undefined
    list: { getSnapshot(): SessionList; subscribe(listener: () => void): () => void }
    open(id: string): void
    scope(id: string): {
      get(name: 'conversation'): { send(text: string): Promise<void> } | undefined
    } | undefined
  }
  workspaces: {
    create(input: { path: string }): Promise<{ id?: string; workspaceId?: string } | string>
    pickDirectory(): Promise<string | null>
    startSession(workspaceId?: string): void
  }
}

interface DesktopShellBridge {
  desktopSettings?: {
    document(): Promise<string>
    request(value: { method: string; value?: unknown }): Promise<unknown>
    onEvent(listener: (value: { event: string; value: unknown }) => void): () => void
  }
  onAction(listener: (id: string) => void): () => void
  onOpenSession(listener: (id: string) => void): () => void
  onNotificationReply(listener: (value: { sessionId: string; text: string }) => void): () => void
  reportNotification(event: {
    type: 'notify' | 'dismiss' | 'badge' | 'reply-error' | 'activity'
    count?: number
    body?: string
    kind?: 'turn-complete' | 'approval' | 'question'
    sessionId?: string
    title?: string
  }): void
  reportLocale(locale: string): void
  reportTheme(value: { colorScheme: 'light' | 'dark'; preference: 'light' | 'dark' | 'system' }): void
  reportState(state: DesktopNavigationState): void
}

export function desktopBridgeClientFactory(moduleRequire: (id: string) => unknown): { apply(ctx: ClientContext): void; inject: string[] } {
    const inject = ['sessions', 'workspaces', 'layout', 'locale', 'uiWorkspace', 'slots']

    const registerDesktopSettings = (ctx: ClientContext, bridge: DesktopShellBridge): void => {
      const api = bridge.desktopSettings
      if (api === undefined || ctx.slots === undefined || ctx.locale.register === undefined || ctx.locale.bind === undefined) return
      const ns = 'desktop-embedded-settings'
      ctx.effect(() => ctx.locale.register!(ns, {
        zh: { notifications: '通知', updates: '更新', appearance: '外观', loading: '正在加载桌面设置…', error: '桌面设置加载失败：', retry: '重试' },
        en: { notifications: 'Notifications', updates: 'Updates', appearance: 'Appearance', loading: 'Loading desktop settings…', error: 'Could not load desktop settings: ', retry: 'Retry' },
      }), 'desktop settings dictionary')
      const t = ctx.locale.bind(ns)
      const React = moduleRequire('react') as {
        createElement(type: string, props: Record<string, unknown>, ...children: unknown[]): unknown
        useState<T>(value: T): [T, (value: T) => void]
        useRef<T>(value: T): { current: T }
        useEffect(effect: () => (() => void), dependencies: unknown[]): void
      }
      const allowed = new Set(['getBootstrap', 'getNotificationPreferences', 'updateNotificationPreferences', 'updateThemePreferences',
        'getUpdatePreferences', 'updateUpdatePreferences', 'getDesktopUpdateState', 'desktopUpdateAction',
        'getHarnessUpdateState', 'updateHarnessUpdatePolicy', 'harnessUpdateAction', 'close'])
      function DesktopSettings(props: { close?: () => void, section: 'notifications' | 'updates' | 'appearance', compact?: boolean }): unknown {
        const close = props.close
        const section = props.section
        const compact = props.compact === true
        const frame = React.useRef<HTMLIFrameElement | null>(null)
        const closeRef = React.useRef(close)
        closeRef.current = close
        const [html, setHtml] = React.useState('')
        const [error, setError] = React.useState('')
        const [attempt, setAttempt] = React.useState(0)
        React.useEffect(() => {
          let disposed = false
          const channel = 'dsh-desktop-settings-v1'
          const post = (value: Record<string, unknown>): void => {
            if (!disposed) frame.current?.contentWindow?.postMessage({ channel, ...value }, '*')
          }
          const receive = (event: MessageEvent): void => {
            if (disposed || frame.current?.contentWindow == null || event.source !== frame.current.contentWindow || event.origin !== 'null') return
            const data = event.data as { channel?: unknown; id?: unknown; method?: unknown; value?: unknown } | null
            if (data === null || typeof data !== 'object' || data.channel !== channel || !Number.isSafeInteger(data.id) || typeof data.method !== 'string') return
            const id = data.id
            if (!allowed.has(data.method)) { post({ id, error: 'Unknown desktop settings method' }); return }
            if (data.method === 'close') { post({ id, value: null }); closeRef.current?.(); return }
            void api!.request({ method: data.method, value: data.value }).then(
              value => post({ id, value }), reason => post({ id, error: String(reason) }),
            )
          }
          window.addEventListener('message', receive)
          const stop = api!.onEvent(value => post(value))
          setError(''); setHtml('')
          void api!.document().then(value => {
            if (!disposed) setHtml(value.replace(/<html\b/i, `<html data-dsh-section="${section}"`))
          }, reason => { if (!disposed) setError(String(reason)) })
          // 分区即页签（2026-09-30 用户拆分决定）：iframe 加载是异步链（document() → srcDoc →
          // 内联脚本起监听），选中事件带重试投递；settings.html 侧监听幂等（setPage + data-dsh-section）。
          let tries = 0
          let timer: ReturnType<typeof setTimeout> | undefined
          const selectSection = (): void => {
            post({ event: 'settingsSection', value: section })
            tries += 1
            if (tries < 26 && !disposed) timer = setTimeout(selectSection, 160)
          }
          selectSection()
          return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); stop(); window.removeEventListener('message', receive) }
        }, [attempt, section])
        if (error) return React.createElement('div', { role: 'alert' }, t('error') + error,
          React.createElement('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, t('retry')))
        if (!html) return React.createElement('div', { role: 'status' }, t('loading'))
        return React.createElement('iframe', {
          ref: frame, title: t(section), srcDoc: html, sandbox: 'allow-scripts',
          'data-dsh-desktop-settings': 'true',
          onLoad: () => frame.current?.contentWindow?.postMessage({ channel: 'dsh-desktop-settings-v1', event: 'settingsSection', value: section }, '*'),
          style: compact
            ? { display: 'block', width: '100%', height: 440, minHeight: 320, border: 0, borderRadius: 8, marginTop: 12 }
            : { display: 'block', width: '100%', height: 'calc(100dvh - 180px)', minHeight: 320, border: 0, borderRadius: 8 },
        })
      }
      // 2026-09-30 用户拍板：桌面设置不再是单块整页分区。通知/更新注册为独立 settings.section
      // （各自只显示自己的页签，settings.html 按 data-dsh-section 藏内部页签栏）；
      // 外观以独立增量行紧随官方 appearance；同 ID 同 priority 会冲突，不能抢占原控件。
      ctx.slots.inject('settings.section', () => {
        const sections = [
          { id: 'desktop-notifications', order: 90, key: 'notifications' as const },
          { id: 'desktop-updates', order: 91, key: 'updates' as const },
        ]
        const disposers = sections.map(entry => ctx.slots!.register(
          { name: 'settings.section', id: entry.id, order: entry.order, locale: ns, label: () => t(entry.key) },
          (props: { close?: () => void }) => DesktopSettings({ close: props.close, section: entry.key }),
        ))
        return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
      })
      ctx.slots.inject('settings.general.item', () => ctx.slots!.register(
        { name: 'settings.general.item', id: 'desktop-appearance', order: 10.5 },
        () => React.createElement('div', {
          'data-dsh-desktop-appearance-panel': 'true',
          style: { gridColumn: '1 / -1', minWidth: 0 },
        }, DesktopSettings({ section: 'appearance', compact: true })),
      ))
    }

    const visibleSessionRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.dcu-wb-session[role="treeitem"][aria-selected]')]
      .filter(element => element.offsetParent !== null)

    const selectedSessionRow = (): HTMLElement | undefined => visibleSessionRows()
      .find(element => element.getAttribute('aria-selected') === 'true')

    const clickByLabel = (patterns: RegExp[]): void => {
      const candidates = [...document.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"]')]
        .filter(element => element.offsetParent !== null)
      candidates.find(element => {
        const labels = [element.getAttribute('aria-label'), element.textContent]
          .filter((label): label is string => typeof label === 'string')
          .map(label => label.trim())
          .filter(label => label !== '')
        return patterns.some(pattern => labels.some(label => pattern.test(label)))
      })?.click()
    }

    const apply = (ctx: ClientContext): void => {
      const bridge = (window as Window & { dshDesktopShell?: DesktopShellBridge }).dshDesktopShell
      if (bridge === undefined) return
      registerDesktopSettings(ctx, bridge)
      let history: string[] = []
      let historyIndex = -1
      let navigating = false
      let disposed = false
      let notificationBaseline: Map<string, { pendingInteraction?: string; running: boolean }> | undefined
      let selectedForDismiss: string | undefined
      const unreadCompletions = new Set<string>()
      let reportedBadgeCount: number | undefined
      let reportedActivityCount: number | undefined

      const notificationKindForInteraction = (value: string | undefined): 'approval' | 'question' | undefined => {
        if (value === undefined) return undefined
        return value === 'question' ? 'question' : 'approval'
      }

      const snapshot = (): SessionList => ctx.sessions.list.getSnapshot()
      // rc.2 owns navigation in uiWorkspace, not in the Session Controller.
      // Retain/release can briefly publish two mainView rows during a switch;
      // observe the settled list in a microtask rather than inventing a visit.
      const currentSession = (state: SessionList): string | undefined => state.current
        ?? Object.keys(state.byId).find(id => (state.byId[id]?.retainedBy?.mainView ?? 0) > 0)
      const openSession = (id: string): void => {
        if (ctx.uiWorkspace !== undefined) ctx.uiWorkspace.openSession(id)
        else ctx.sessions.open(id)
      }
      // 子代理（origin === 'subagent'）不属于用户可见任务，不计入任务栏角标（上游 v1.0.50）。
      const isBadgeSession = (row: SessionList['byId'][string] | undefined): boolean => row !== undefined && row.origin !== 'subagent'
      const reportBadge = (): void => {
        if (reportedBadgeCount === unreadCompletions.size) return
        reportedBadgeCount = unreadCompletions.size
        bridge.reportNotification({ type: 'badge', count: unreadCompletions.size })
      }
      const markSessionRead = (id: string): void => {
        if (!unreadCompletions.delete(id)) return
        reportBadge()
      }
      const latestAssistantPreview = (id: string): string | undefined => {
        const nodes = ctx.sessions.binding(id)?.session.getSnapshot().nodes
        if (!Array.isArray(nodes)) return undefined
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index]
          if (node?.kind !== 'assistant' || !Array.isArray(node.blocks)) continue
          const text = node.blocks
            .filter(block => block?.kind === 'text' && typeof block.text === 'string')
            .map(block => block.text?.trim() ?? '')
            .filter(Boolean)
            .join('\n')
            .replace(/\s+/g, ' ')
            .trim()
          if (text !== '') return text.slice(0, 500)
        }
        return undefined
      }
      const report = (): void => {
        const rows = visibleSessionRows()
        const currentRow = selectedSessionRow()
        const currentIndex = currentRow === undefined ? -1 : rows.indexOf(currentRow)
        bridge.reportState({
          canBack: historyIndex > 0,
          canForward: historyIndex >= 0 && historyIndex < history.length - 1,
          canPreviousChat: currentIndex > 0,
          canNextChat: currentIndex >= 0 && currentIndex < rows.length - 1,
        })
      }
      const trackCurrent = (): void => {
        if (disposed || navigating) return
        const nextSnapshot = snapshot()
        const current = currentSession(nextSnapshot)
        const previousHistory = history
        const previousIndex = historyIndex
        history = history.filter(id => nextSnapshot.byId[id] !== undefined)
        historyIndex = previousHistory.slice(0, previousIndex + 1).filter(id => nextSnapshot.byId[id] !== undefined).length - 1
        const isInitialSnapshot = notificationBaseline === undefined
        if (current !== undefined && history[historyIndex] !== current) {
          history = history.slice(0, historyIndex + 1)
          history.push(current)
          historyIndex = history.length - 1
        }
        if (current !== selectedForDismiss) {
          selectedForDismiss = current
          if (current !== undefined) {
            bridge.reportNotification({ type: 'dismiss', sessionId: current })
            if (document.hasFocus()) markSessionRead(current)
          }
        }
        const nextBaseline = new Map<string, { pendingInteraction?: string; running: boolean }>()
        let activityCount = 0
        for (const id of [...unreadCompletions]) {
          const row = nextSnapshot.byId[id]
          if (row === undefined || !isBadgeSession(row)) unreadCompletions.delete(id)
        }
        for (const id of nextSnapshot.ids) {
          const row = nextSnapshot.byId[id]
          if (row === undefined) continue
          if (row.running || row.pendingInteraction !== undefined) activityCount += 1
          // 历史已完成任务只在首次建立基线时计入；后续列表刷新不能把
          // 用户已经读过并清除的任务重新标记为未读（上游 v1.0.46）。
          if (isInitialSnapshot && row.completed === true && isBadgeSession(row)) unreadCompletions.add(id)
          const previous = notificationBaseline?.get(id)
          nextBaseline.set(id, { running: row.running, ...(row.pendingInteraction === undefined ? {} : { pendingInteraction: row.pendingInteraction }) })
          if (previous === undefined) continue
          if (previous.running && !row.running && row.pendingInteraction === undefined && isBadgeSession(row)) {
            unreadCompletions.add(id)
            bridge.reportNotification({
              type: 'notify',
              kind: 'turn-complete',
              sessionId: id,
              title: row.displayTitle,
              body: latestAssistantPreview(id),
            })
          }
          const interactionKind = notificationKindForInteraction(row.pendingInteraction)
          if (interactionKind !== undefined && interactionKind !== notificationKindForInteraction(previous.pendingInteraction)) {
            bridge.reportNotification({
              type: 'notify',
              kind: interactionKind,
              sessionId: id,
              title: row.displayTitle,
            })
          }
        }
        if (current !== undefined && document.hasFocus()) unreadCompletions.delete(current)
        notificationBaseline = nextBaseline
        if (reportedActivityCount !== activityCount) {
          reportedActivityCount = activityCount
          bridge.reportNotification({ type: 'activity', count: activityCount })
        }
        reportBadge()
        queueMicrotask(report)
      }
      const openHistory = (offset: number): void => {
        trackCurrent()
        const next = historyIndex + offset
        const id = history[next]
        if (id === undefined) return
        const previousIndex = historyIndex
        historyIndex = next
        navigating = true
        try { openSession(id) }
        catch (error) { historyIndex = previousIndex; console.error('会话导航失败。', error) }
        finally { navigating = false }
        queueMicrotask(report)
      }
      const openAdjacent = (offset: number): void => {
        const rows = visibleSessionRows()
        const current = selectedSessionRow()
        const index = current === undefined ? -1 : rows.indexOf(current)
        rows[index + offset]?.click()
        setTimeout(report, 80)
      }
      const openFolder = async (): Promise<void> => {
        const path = await ctx.workspaces.pickDirectory()
        if (path === null) return
        const created = await ctx.workspaces.create({ path })
        const workspaceId = typeof created === 'string'
          ? created
          : typeof created === 'object' && created !== null
            ? created.id ?? created.workspaceId
            : undefined
        if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
          throw new Error('创建工作区后未返回有效的 workspaceId。')
        }
        ctx.workspaces.startSession(workspaceId)
      }
      const sendNotificationReply = async (value: { sessionId: string; text: string }): Promise<void> => {
        const text = value.text.trim()
        if (text === '') return
        const conversation = ctx.sessions.scope(value.sessionId)?.get('conversation')
        if (conversation === undefined) throw new Error(`会话 ${value.sessionId} 不提供 conversation 服务。`)
        await conversation.send(text)
        markSessionRead(value.sessionId)
        bridge.reportNotification({ type: 'dismiss', sessionId: value.sessionId })
      }
      const onAction = (id: string): void => {
        // Omitting the id inherits the selected Session's Workspace, exactly like
        // the DSH "新建任务" control.
        if (id === 'new-chat') ctx.workspaces.startSession()
        else if (id === 'open-folder') void openFolder().catch(error => { console.error('打开文件夹失败。', error) })
        else if (id === 'toggle-sidebar') ctx.layout.toggleSidebar()
        else if (id === 'previous-chat') openAdjacent(-1)
        else if (id === 'next-chat') openAdjacent(1)
        else if (id === 'back') openHistory(-1)
        else if (id === 'forward') openHistory(1)
        else if (id === 'find') clickByLabel([/^(?:搜索会话|查找|search sessions|find)$/i])
        else if (id === 'settings') {
          const trigger = document.querySelector<HTMLElement>('.dcu-settings-seat [data-dcu-settings-trigger],.dcu-settings-seat [aria-haspopup="dialog"]')
          if (trigger !== null) trigger.click()
          else clickByLabel([/^设置$|^settings$|preferences/i])
        }
      }

      ctx.effect(() => {
        const stopAction = bridge.onAction(onAction)
        const stopOpenSession = bridge.onOpenSession(id => { markSessionRead(id); openSession(id) })
        const stopNotificationReply = bridge.onNotificationReply(value => {
          void sendNotificationReply(value).catch(error => {
            console.error('通知回复发送失败。', error)
            bridge.reportNotification({ type: 'reply-error', sessionId: value.sessionId })
          })
        })
        let queued = false
        const stopList = ctx.sessions.list.subscribe(() => {
          if (ctx.uiWorkspace === undefined) { trackCurrent(); return }
          if (queued) return
          queued = true
          queueMicrotask(() => { queued = false; trackCurrent() })
        })
        const reportLocale = (): void => { bridge.reportLocale(ctx.locale.getSnapshot().active) }
        const stopLocale = ctx.locale.subscribe(reportLocale)
        const onWindowFocus = (): void => {
          const current = currentSession(snapshot())
          if (current !== undefined) markSessionRead(current)
        }
        window.addEventListener('focus', onWindowFocus)
        const observer = new MutationObserver(report)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'class'] })
        const onLogoDoubleClick = (event: MouseEvent): void => {
          const target = event.target as HTMLElement
          if (target.closest('.dcu-brand') === null) return
          event.preventDefault()
          event.stopPropagation()
          ctx.layout.toggleSidebar()
        }
        document.addEventListener('dblclick', onLogoDoubleClick, true)
        trackCurrent()
        reportLocale()
        return () => { disposed = true; stopAction(); stopOpenSession(); stopNotificationReply(); stopList(); stopLocale(); window.removeEventListener('focus', onWindowFocus); observer.disconnect(); document.removeEventListener('dblclick', onLogoDoubleClick, true) }
      }, 'desktop-shell bridge')
    }

    return { apply, inject }
}

export function desktopBridgeClientBundle(): string {
  return `window.__ModuleLoader__.load({id:'dsh-desktop-bridge',factory:${desktopBridgeClientFactory.toString()}});\n`
}
