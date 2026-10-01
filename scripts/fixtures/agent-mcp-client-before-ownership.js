window.__ModuleLoader__.load({ id: 'dsh-agent-mcp', factory: require => {
  const { createElement: h, useState, useRef, useEffect } = require('react')
  const NS = 'agent-mcp-settings'
  const zh = {
    nav: '多智能体交互管理', title: '多智能体交互管理', intro: '统一管理外部智能体与 DSH 之间的三条通道。',
    online: '正在监听', offline: '未监听', unknown: '正在读取状态…', refresh: '刷新状态', check: '测试连接', checking: '处理中…',
    endpoint: '接口地址', transport: '传输方式', mode: '中继模式：任务由目标会话已选模型执行，沿用该会话的工具与审批。',
    token: 'Bearer 令牌', secret: '默认隐藏；令牌可操作你的 DSH 会话，请勿分享。重启后保持不变。',
    reveal: '显示令牌', hide: '隐藏令牌', copyToken: '复制令牌', copyUrl: '复制地址', copyConfig: '复制连接信息',
    copied: '已复制到剪贴板。', copyFailed: '复制失败，请在下方手动选择并复制；敏感内容请妥善保管。',
    failed: '操作失败：请确认 DSH 已加载插件并已登录，再刷新重试。', checkFailed: '连接自检失败；未发送任务。请查看插件状态后重试。',
    checked: '自检通过：MCP 握手和 6 个工具正常；未投递任务。', refreshed: '状态已刷新。',
    local: '仅限与 DSH 同一台电脑。仅监听本机回环；不支持浏览器跨站直连。没有重启或退出工具。',
    tools: '可用工具', manual: '手动复制内容', limits: '任务超时（毫秒） / 最大保留任务数',
    t0: '能力与使用约束', t1: '列出现有会话', t2: '向指定会话投递任务', t3: '查询任务状态与结果', t4: '取消任务', t5: '读取本机状态发现文件',
    chBridge: '通道一 · 外部托管执行（Codex / OpenCode）',
    chHttp: '通道二 · DSH HTTP 指令通道', chMcp: '通道三 · DSH MCP 接入',
    bridgeNotConfigured: '未配置 Bridge 目录：在插件设置里填写 Agent Bridge 所在目录后即可接管。',
    bridgeOnline: 'Bridge 正在运行', bridgeOffline: 'Bridge 未运行', bridgePortBusy: '该端口不是 Agent Bridge：不会启动，也不会结束占用它的程序。',
    bridgeStart: '启动 Bridge', bridgeStop: '停止 Bridge', bridgeStarted: 'Bridge 已就绪。', bridgeStopped: 'Bridge 已停止。',
    bridgeNotOwned: '不是本 DSH 启动的进程，拒绝停止；如需回收请手动处理。',
    bridgeStoppedByRestart: 'Bridge 在本 DSH 之前就已运行，按外部实例接管，不受本插件启停控制。',
    dir: 'Bridge 目录', port: '端口',
    kpiTotal: '总数', kpiActive: '进行中', kpiOk: '成功', kpiFail: '失败', kpiUnknown: '状态不明',
    alertDispatch: '存在派发状态未知的运行：任务既没确认送达也没确认失败，结果未知，请到 Bridge 控制台核对。',
    alertVerify: '已产生结果 ≠ 已通过验证。本页只记录执行结果，不做验收判定，验收仍需你自己确认。',
    colRun: '运行', colAgent: '智能体', colState: '状态', colDispatch: '派发', colVerify: '未验证', colTime: '用时', colAction: '操作',
    colMsg: '消息', colFlow: '来源 → 目标', colDelivery: '送达', colWorkspace: '工作区', colPath: '路径', colLease: '可写',
    colVersion: '版本', colCaps: '能力', colLastSeen: '最近活动',
    cancel: '取消', cancelDone: '已请求取消。', none: '暂无记录。',
    noResult: '无结果', hasResult: '有结果',
    httpNote: '此通道由 DSH 自带的 dsh-agent-bridge 提供，本页只读显示，不接管它的启停。',
    guide: '使用说明', guideIntro: '本页是三条通道的总管台。下面按「配置一次 → 怎么用 → 出问题怎么办」展开。',
    gSetup: '一、首次配置（只做一次）',
    gSetup1: '在 DSH 插件设置里找到 dsh-agent-mcp，把「Bridge 目录」填成含 start.py 的那一层 —— 你的环境是 G:/智能体桥梁/AgentBridge；端口保持 8765 不用改。',
    gSetup2: '换盘时只改这一个配置项，页面和代码里都不写死盘符。目录留空时本页显示「未配置」，不会去猜路径。',
    gSetup3: '改完点上面的「刷新状态」。目录填错只会显示「未运行」，不会误杀任何进程。',
    gBridge: '二、通道一：让 Codex / OpenCode 替你干活',
    gB1: '先探活，看有哪些端真的可用（supported 是实测过的，unverified 别当可用）：',
    gB1c: 'python cli.py probe',
    gB2: '注册一个工作区，会打印一个 workspace_id，后面所有命令都带上它：',
    gB2c: 'python cli.py register "C:/你的项目路径" --agent dsh',
    gB2n: '加 --writable 才允许改文件。写权限会触发独占租约：同一工作区同时只允许一个写入者，第二个请求返回 WORKSPACE_LEASED。',
    gB3: '派发一个托管任务。默认只读，要让它改文件就加 --write：',
    gB3c: 'python cli.py run codex <workspace_id> "分析这个项目的架构"\npython cli.py run codex <workspace_id> "修复登录超时问题" --write --key fix-1',
    gB3n: 'OpenCode 要显式给模型：python cli.py run opencode <workspace_id> "写一份 README" --model opencode/space-bunny-free。--resume <会话ID> 能接上已有会话，必须写明确的 ID，不允许「恢复最后一个」——否则自动化会撞上你正在手动用的任务。',
    gB4: '任务在后台跑。回本页点「刷新状态」看进度，要在命令行实时跟就用：',
    gB4c: 'python cli.py watch <run_id>     # 轮询到运行结束\npython cli.py runs              # 最近 50 次运行\npython cli.py events <run_id>    # 事件流\npython cli.py cancel <run_id>    # 取消',
    gB5: '本页运行表里的「取消」按钮走的是同一套接口，不用你敲命令。',
    gKnow: '三、必须知道的三件事',
    gK1: '结果 ≠ 验收。Bridge 只记录执行结果，「未验证」列显示「有结果」不等于通过验证，验收仍然要你自己确认。',
    gK2: '重复提交不会启动第二个任务。带相同 --key 的请求会返回原来的 run_id 并提示 deduplicated。',
    gK3: '取消不确认就不改状态。原生进程停不掉时 cancel 返回 CANCEL_UNCONFIRMED 并保持原状，不会假装取消成功。',
    gHttp: '四、通道二：DSH HTTP 指令通道',
    gHttp1: '这条通道由 DSH 自带的 dsh-agent-bridge 提供，本页只读显示它的地址和在线状态。它本来就是 DSH 自己的进程，所以不接管它的启停。',
    gMcp: '五、通道三：外部客户端接 DSH（ZCode / Qoder 等）',
    gMcp1: '在客户端里添加 HTTP / Streamable HTTP MCP 服务，名称可填 dsh-agent，地址和 Authorization 头用上面的「复制连接信息」。',
    gMcp2: '复制的连接信息是通用说明，不是任何特定客户端的导入格式。',
    gMcp3: '连上后先调 dsh_capabilities，再 dsh_list_sessions 选一个已有会话，然后 dsh_send_task 投递。发任务会真的执行操作并可能产生模型费用。',
    gTrouble: '六、遇到问题',
    gT1: '显示「该端口不是 Agent Bridge」：8765 被别的程序占了。本页不会启动，也不会结束占用它的程序 —— 换个端口或先腾出 8765。',
    gT2: '点「停止 Bridge」被拒：这个进程不是本 DSH 启动的（常见于你手动 python start.py，或 DSH 重启后句柄已丢）。要回收就在命令行自己停。',
    gT3: '显示「未配置」：Bridge 目录还是空的，回第一节填上。',
    gT4: '命令报 cannot reach the bridge：Bridge 没在跑。点上面的「启动 Bridge」，或去 Bridge 目录执行 python start.py。',
    gT5: '上面所有命令都在 Bridge 目录里执行；cli.py 会自己读 data/admin.token，不用手动复制令牌。',
  }
  const en = {
    nav: 'Multi-agent interaction', title: 'Multi-agent interaction', intro: 'Manage the three channels between external agents and DSH in one place.',
    online: 'Listening', offline: 'Not listening', unknown: 'Loading status…', refresh: 'Refresh status', check: 'Test connection', checking: 'Working…',
    endpoint: 'Endpoint', transport: 'Transport', mode: 'Relay mode: the selected session model executes tasks with its own tools and approval policy.',
    token: 'Bearer token', secret: 'Hidden by default. This token grants access to your DSH sessions. Keep it private; it survives restarts.',
    reveal: 'Show token', hide: 'Hide token', copyToken: 'Copy token', copyUrl: 'Copy URL', copyConfig: 'Copy connection details',
    copied: 'Copied to clipboard.', copyFailed: 'Copy failed. Select and copy the content below manually; keep credentials private.',
    failed: 'Request failed. Check plugin availability and DSH authentication, then refresh.', checkFailed: 'Connection test failed. No task was sent. Check plugin status and retry.',
    checked: 'Verified MCP handshake and all 6 tools. No task was submitted.', refreshed: 'Status refreshed.',
    local: 'Same computer only. Loopback listener; cross-origin browser access is blocked. No restart or quit tools.',
    tools: 'Available tools', manual: 'Content for manual copying', limits: 'Task timeout (ms) / retained task limit',
    t0: 'Capabilities and constraints', t1: 'List existing sessions', t2: 'Submit a session task', t3: 'Read task status and results', t4: 'Cancel a task', t5: 'Read local discovery state',
    chBridge: 'Channel 1 · External managed execution (Codex / OpenCode)',
    chHttp: 'Channel 2 · DSH HTTP command channel', chMcp: 'Channel 3 · DSH MCP access',
    bridgeNotConfigured: 'No Bridge folder configured. Fill in the Agent Bridge location in plugin settings to take it over.',
    bridgeOnline: 'Bridge is running', bridgeOffline: 'Bridge is not running', bridgePortBusy: 'That port is not an Agent Bridge. It will not be started, and the occupying process will not be killed.',
    bridgeStart: 'Start Bridge', bridgeStop: 'Stop Bridge', bridgeStarted: 'Bridge is ready.', bridgeStopped: 'Bridge stopped.',
    bridgeNotOwned: 'Not started by this DSH, so it will not be stopped. Stop it manually if you need to reclaim it.',
    bridgeStoppedByRestart: 'The Bridge was already running before this DSH; it is treated as an external instance and is not start/stop controlled.',
    dir: 'Bridge folder', port: 'Port',
    kpiTotal: 'Total', kpiActive: 'Active', kpiOk: 'Succeeded', kpiFail: 'Failed', kpiUnknown: 'Unknown',
    alertDispatch: 'Some runs have an unknown dispatch state: delivery was neither confirmed nor refused. The outcome is unknown — check the Bridge console.',
    alertVerify: 'A produced result is not a passed verification. This page records execution only; acceptance is still yours to confirm.',
    colRun: 'Run', colAgent: 'Agent', colState: 'State', colDispatch: 'Dispatch', colVerify: 'Unverified', colTime: 'Duration', colAction: 'Action',
    colMsg: 'Message', colFlow: 'From → To', colDelivery: 'Delivery', colWorkspace: 'Workspace', colPath: 'Path', colLease: 'Writable',
    colVersion: 'Version', colCaps: 'Capabilities', colLastSeen: 'Last seen',
    cancel: 'Cancel', cancelDone: 'Cancellation requested.', none: 'No records yet.',
    noResult: 'No result', hasResult: 'Has result',
    httpNote: 'This channel is provided by DSH’s built-in dsh-agent-bridge. It is displayed read-only; its lifecycle is not taken over here.',
    guide: 'How to use this', guideIntro: 'This page is the control panel for all three channels, laid out as: configure once → how to use it → what to do when something breaks.',
    gSetup: '1. First-time setup (once)',
    gSetup1: 'In the DSH plugin settings for dsh-agent-mcp, set "Bridge folder" to the folder that contains start.py — on this machine, G:/智能体桥梁/AgentBridge. Leave the port at 8765.',
    gSetup2: 'When the drive letter changes, edit that one setting. No drive letter is baked into the page or the code. While the folder is empty this page shows "not configured" instead of guessing a path.',
    gSetup3: 'Then click "Refresh status". A wrong folder only shows "not running"; nothing is ever killed by mistake.',
    gBridge: '2. Channel 1: let Codex / OpenCode do the work',
    gB1: 'Probe first to see which endpoints are actually usable (supported is measured; do not treat unverified as available):',
    gB1c: 'python cli.py probe',
    gB2: 'Register a workspace. It prints a workspace_id that every later command needs:',
    gB2c: 'python cli.py register "C:/your/project" --agent dsh',
    gB2n: 'Add --writable to allow edits. Write access takes an exclusive lease: only one writer per workspace at a time, and a second request returns WORKSPACE_LEASED.',
    gB3: 'Submit a managed run. It is read-only by default; add --write to let it change files:',
    gB3c: 'python cli.py run codex <workspace_id> "analyse the architecture of this project"\npython cli.py run codex <workspace_id> "fix the login timeout bug" --write --key fix-1',
    gB3n: 'OpenCode needs an explicit model: python cli.py run opencode <workspace_id> "write a README" --model opencode/space-bunny-free. --resume <session-id> continues an existing session and must name the id explicitly — "resume the last one" is refused on purpose, so automation cannot attach to the session you are using by hand.',
    gB4: 'The run continues in the background. Come back here and click "Refresh status", or follow it live from the command line:',
    gB4c: 'python cli.py watch <run_id>     # poll until the run stops\npython cli.py runs              # last 50 runs\npython cli.py events <run_id>    # event stream\npython cli.py cancel <run_id>    # cancel',
    gB5: 'The "Cancel" button in the run table below calls the same interface, so you do not have to type the command.',
    gKnow: '3. Three things you must know',
    gK1: 'A result is not an acceptance. The Bridge records execution only: "Has result" under Unverified does not mean it passed review — that judgement is still yours.',
    gK2: 'A repeated submission does not start a second task. The same --key returns the original run_id and reports deduplicated.',
    gK3: 'Cancel does not change state unless it is confirmed. If the native process will not stop, cancel returns CANCEL_UNCONFIRMED and leaves the run untouched rather than pretending.',
    gHttp: '4. Channel 2: DSH HTTP command channel',
    gHttp1: 'This channel comes with DSH via dsh-agent-bridge, and this page only reads its address and health. It is already a DSH process, so its lifecycle is not taken over here.',
    gMcp: '5. Channel 3: connect an external client to DSH (ZCode / Qoder, …)',
    gMcp1: 'In your client add an HTTP / Streamable HTTP MCP server, name it dsh-agent if you like, and use "Copy connection details" above for the address and the Authorization header.',
    gMcp2: 'The copied details are generic notes, not an import format for any particular client.',
    gMcp3: 'Once connected, call dsh_capabilities first, then dsh_list_sessions to pick an existing session, then dsh_send_task. Sending a task performs real operations and may incur model costs.',
    gTrouble: '6. When something goes wrong',
    gT1: 'It says "That port is not an Agent Bridge": something else holds 8765. This page will not start a Bridge, and will not kill the occupying process — change the port or free 8765 first.',
    gT2: 'Stop is refused: the process was not started by this DSH (common after a manual python start.py, or after a DSH restart lost the handle). Reclaim it by stopping it yourself.',
    gT3: 'It says "not configured": the Bridge folder is still empty. Go back to step 1.',
    gT4: 'A command reports "cannot reach the bridge": the Bridge is not running. Click "Start Bridge" above, or run python start.py in the Bridge folder.',
    gT5: 'Run all the commands above from inside the Bridge folder; cli.py reads data/admin.token itself, so there is no token to copy by hand.',
  }
  const css = `.dsh-mcp-settings{width:100%;max-width:720px;min-width:0;box-sizing:border-box;line-height:1.65;overflow-wrap:anywhere}.dsh-mcp-settings *{box-sizing:border-box}.dsh-mcp-settings h2{font-size:20px;margin:0 0 8px}.dsh-mcp-settings h3{font-size:15px;margin:20px 0 8px}.dsh-mcp-settings h4{font-size:13px;margin:14px 0 6px;color:#6b7280}.dsh-mcp-settings p{margin:8px 0}.dsh-mcp-settings .mcp-card{border:1px solid var(--border-color,#d5d9e0);border-radius:10px;padding:16px;margin:14px 0}.dsh-mcp-settings .mcp-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.dsh-mcp-settings button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border-color,#d5d9e0);border-radius:6px;padding:6px 12px;cursor:pointer;white-space:normal}.dsh-mcp-settings button:disabled{opacity:.5;cursor:wait}.dsh-mcp-settings button:focus-visible{outline:2px solid #438df7;outline-offset:2px}.dsh-mcp-settings input,.dsh-mcp-settings textarea{width:100%;min-width:0;color:inherit;background:transparent;border:1px solid var(--border-color,#d5d9e0);border-radius:6px;padding:8px;font:inherit}.dsh-mcp-settings code{white-space:pre-wrap;overflow-wrap:anywhere}.dsh-mcp-settings ul,.dsh-mcp-settings ol{padding-left:22px}.dsh-mcp-settings [role=status]{padding:8px 0;min-height:28px}.dsh-mcp-settings .mcp-error{color:#b45309}.dsh-mcp-settings .mcp-kpi{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.dsh-mcp-settings .mcp-kpi span{border:1px solid var(--border-color,#d5d9e0);border-radius:999px;padding:2px 10px;font-size:13px}.dsh-mcp-settings .mcp-alert{border-left:3px solid #b45309;background:rgba(180,83,9,.08);padding:8px 10px;margin:10px 0;border-radius:4px}.dsh-mcp-settings .mcp-scroll{max-width:100%;overflow-x:auto;margin:8px 0}.dsh-mcp-settings table{border-collapse:collapse;width:100%;font-size:13px}.dsh-mcp-settings th,.dsh-mcp-settings td{border-bottom:1px solid var(--border-color,#d5d9e0);padding:6px 8px;text-align:left;vertical-align:top;white-space:nowrap}.dsh-mcp-settings th{font-weight:600;color:#6b7280}.dsh-mcp-settings .mcp-empty{color:#6b7280;font-size:13px}.dsh-mcp-settings details{border:1px solid var(--border-color,#d5d9e0);border-radius:8px;padding:8px 12px;margin:10px 0;min-width:0}.dsh-mcp-settings details[open] summary{margin-bottom:8px}.dsh-mcp-settings summary{cursor:pointer;font-weight:600}.dsh-mcp-settings .mcp-cmd{display:block;font-family:ui-monospace,Consolas,monospace;font-size:12px;background:rgba(127,127,127,.08);border-radius:6px;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}`
  const clock = value => {
    if (!value) return '—'
    const at = new Date(value * 1000)
    return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString()
  }
  function Settings({ t }) {
    const [status, setStatus] = useState(null), [busy, setBusy] = useState(false), [secret, setSecret] = useState('')
    const [notice, setNotice] = useState(''), [manual, setManual] = useState(''), [error, setError] = useState(false)
    const [bridge, setBridge] = useState(null), [bridgeBusy, setBridgeBusy] = useState(false), [bridgeNotice, setBridgeNotice] = useState('')
    const life = useRef(null), lock = useRef(false), bridgeLock = useRef(false), secretEpoch = useRef(0)
    const clearSecrets = () => { secretEpoch.current++; setSecret(''); setManual('') }
    async function request(operation, signal, extra) {
      const response = await fetch('/dsh-agent-mcp/settings', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-dsh-agent-mcp': '1' }, body: JSON.stringify({ operation, ...extra }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(operation === 'bridge.start' ? 45000 : 8000)]) })
      if (!response.ok) throw new Error('Request failed')
      return (await response.json()).value
    }
    async function bridgeAction(kind, extra) {
      const controller = life.current
      if (!controller || controller.signal.aborted || bridgeLock.current) return
      bridgeLock.current = true; setBridgeBusy(true); setBridgeNotice('')
      try {
        const value = await request(`bridge.${kind}`, controller.signal, extra)
        if (controller.signal.aborted) return
        if (kind === 'status') setBridge(value)
        else if (kind === 'cancel') setBridgeNotice(t('cancelDone'))
        else setBridgeNotice(value?.ok ? t(kind === 'start' ? 'bridgeStarted' : 'bridgeStopped') : bridgeError(value))
        if (kind === 'status' || kind === 'start' || kind === 'stop') setBridge(await request('bridge.status', controller.signal))
      } catch { if (!controller.signal.aborted) setBridgeNotice(t('failed')) }
      finally { if (life.current === controller && !controller.signal.aborted) { bridgeLock.current = false; setBridgeBusy(false) } }
    }
    function bridgeError(value) {
      if (!value) return t('failed')
      if (value.error === 'NOT_OWNED') return t('bridgeNotOwned')
      if (value.error === 'PORT_NOT_BRIDGE') return t('bridgePortBusy')
      if (value.error === 'BRIDGE_DIR_NOT_CONFIGURED') return t('bridgeNotConfigured')
      return t('failed')
    }
    async function action(kind) {
      const controller = life.current
      if (!controller || controller.signal.aborted || lock.current) return
      lock.current = true; setBusy(true); setNotice(''); setError(false)
      const epoch = secretEpoch.current
      try {
        if (kind === 'refresh') {
          clearSecrets()
          const value = await request('status', controller.signal)
          if (!controller.signal.aborted) { setStatus(value); setNotice(t('refreshed')) }
        } else if (kind === 'check') {
          await request('check', controller.signal)
          if (!controller.signal.aborted) setNotice(t('checked'))
        } else {
          let value
          if (kind === 'copyUrl') value = status.url
          else {
            const credential = await request('credentials', controller.signal)
            if (controller.signal.aborted || epoch !== secretEpoch.current) return
            if (kind === 'reveal') { setSecret(credential.token); return }
            value = kind === 'copyToken' ? credential.token : JSON.stringify({ name: 'dsh-agent', transport: 'http', url: credential.url, headers: { Authorization: `Bearer ${credential.token}` } }, null, 2)
          }
          if (controller.signal.aborted || epoch !== secretEpoch.current) return
          try { await navigator.clipboard.writeText(value); if (!controller.signal.aborted) setNotice(t('copied')) }
          catch { if (!controller.signal.aborted && epoch === secretEpoch.current) { setManual(value); setNotice(t('copyFailed')); setError(true) } }
        }
      } catch {
        if (!controller.signal.aborted) { setNotice(t(kind === 'check' ? 'checkFailed' : 'failed')); setError(true); if (kind === 'refresh') setStatus(null) }
      } finally { if (life.current === controller && !controller.signal.aborted) { lock.current = false; setBusy(false) } }
    }
    useEffect(() => {
      const controller = new AbortController(); life.current = controller; lock.current = false; bridgeLock.current = false
      void action('refresh')
      void bridgeAction('status')
      const hidden = () => { if (document.hidden) clearSecrets() }
      document.addEventListener('visibilitychange', hidden)
      return () => { controller.abort(); secretEpoch.current++; document.removeEventListener('visibilitychange', hidden); life.current = null }
    }, [])
    const button = (kind, label, disabled = false) => h('button', { type: 'button', 'data-mcp-action': kind, disabled: busy || disabled, onClick: () => void action(kind) }, t(label || kind))
    const bridgeButton = (kind, label, disabled = false) => h('button', { type: 'button', 'data-mcp-bridge': kind, disabled: bridgeBusy || disabled, onClick: () => void bridgeAction(kind) }, t(label))
    const table = (headers, rows) => h('div', { className: 'mcp-scroll' }, h('table', null,
      h('thead', null, h('tr', null, ...headers.map((label, i) => h('th', { key: i }, t(label))))),
      h('tbody', null, ...rows)))
    const empty = label => h('p', { className: 'mcp-empty' }, t('none'))
    // Collapsed by default: a long guide that always expanded would bury the live
    // state it is meant to explain, and it stays out of the layout width budget.
    const cmd = key => h('code', { className: 'mcp-cmd' }, t(key))
    const guide = () =>
      h('div', { className: 'mcp-card' },
        h('h3', null, t('guide')), h('p', null, t('guideIntro')),
        h('details', { key: 'g-setup', open: true }, h('summary', null, t('gSetup')),
          h('p', null, t('gSetup1')), h('p', null, t('gSetup2')), h('p', null, t('gSetup3'))),
        h('details', { key: 'g-bridge' }, h('summary', null, t('gBridge')),
          h('p', null, t('gB1')), cmd('gB1c'), h('p', null, t('gB2')), cmd('gB2c'),
          h('p', null, t('gB2n')), h('p', null, t('gB3')), cmd('gB3c'), h('p', null, t('gB3n')),
          h('p', null, t('gB4')), cmd('gB4c'), h('p', null, t('gB5'))),
        h('details', { key: 'g-know' }, h('summary', null, t('gKnow')),
          h('p', null, t('gK1')), h('p', null, t('gK2')), h('p', null, t('gK3'))),
        h('details', { key: 'g-http' }, h('summary', null, t('gHttp')), h('p', null, t('gHttp1'))),
        h('details', { key: 'g-mcp' }, h('summary', null, t('gMcp')),
          h('p', null, t('gMcp1')), h('p', null, t('gMcp2')), h('p', null, t('gMcp3'))),
        h('details', { key: 'g-trouble' }, h('summary', null, t('gTrouble')),
          h('p', null, t('gT1')), h('p', null, t('gT2')), h('p', null, t('gT3')),
          h('p', null, t('gT4')), h('p', null, t('gT5'))))
    const runs = bridge?.runs || []
    const byState = bridge?.stats?.by_state || {}
    const dispatchUnknown = runs.some(run => run.dispatch_state === 'DISPATCH_UNKNOWN')
    const online = bridge?.online === true
    const http = status?.httpChannel
    return h('section', { className: 'dsh-mcp-settings', 'aria-label': t('title') },
      h('h2', null, t('title')), h('p', null, t('intro')),
      guide(),

      h('div', { className: 'mcp-card' },
        h('h3', null, t('chBridge')),
        h('strong', { 'data-mcp-bridge-state': bridge ? (online ? 'online' : (bridge.reason === 'PORT_NOT_BRIDGE' ? 'port-busy' : (bridge.reason === 'BRIDGE_DIR_NOT_CONFIGURED' ? 'unconfigured' : 'offline'))) : 'unknown' },
          t(bridge ? (online ? 'bridgeOnline' : (bridge.reason === 'PORT_NOT_BRIDGE' ? 'bridgePortBusy' : (bridge.reason === 'BRIDGE_DIR_NOT_CONFIGURED' ? 'bridgeNotConfigured' : 'bridgeOffline'))) : 'unknown')),
        h('div', { className: 'mcp-actions' },
          bridgeButton('status', 'refresh'),
          bridgeButton('start', 'bridgeStart', online || !status?.bridgeConfigured),
          bridgeButton('stop', 'bridgeStop', !online),
          bridgeBusy && h('span', null, t('checking'))),
        h('div', { role: 'note', 'data-mcp-bridge-notice': '1' }, bridgeNotice),
        !online && bridge?.reason === 'UNREACHABLE' && h('p', { className: 'mcp-empty' }, t('bridgeStoppedByRestart')),
        online && h('div', null,
          h('div', { className: 'mcp-kpi' },
            ...[['kpiTotal', bridge.stats.total], ['kpiActive', bridge.stats.active], ['kpiOk', byState.succeeded || 0],
              ['kpiFail', (byState.failed || 0) + (byState['timed-out'] || 0)],
              ['kpiUnknown', (bridge.stats.by_dispatch || {}).DISPATCH_UNKNOWN || 0]]
              .map(([key, value]) => h('span', { key }, `${t(key)} ${value}`))),
          h('p', { className: 'mcp-alert', 'data-mcp-alert': 'verify' }, t('alertVerify')),
          dispatchUnknown && h('p', { className: 'mcp-alert', 'data-mcp-alert': 'dispatch' }, t('alertDispatch')),
          h('h4', null, t('colRun')),
          runs.length
            ? table(['colRun', 'colAgent', 'colState', 'colDispatch', 'colVerify', 'colTime', 'colAction'], runs.map(run => h('tr', { key: run.run_id },
                h('td', null, h('code', null, run.run_id.slice(0, 12))),
                h('td', null, run.agent_id || '—'),
                h('td', null, run.state || '—'),
                h('td', null, run.dispatch_state || '—'),
                h('td', null, run.verified ? t('hasResult') : t('noResult')),
                h('td', null, `${run.duration_s || 0}s`),
                h('td', null, h('button', { type: 'button', 'data-mcp-cancel': run.run_id, disabled: bridgeBusy,
                  onClick: () => void bridgeAction('cancel', { run_id: run.run_id }) }, t('cancel'))))))
            : empty('runs'),
          h('h4', null, t('colMsg')),
          bridge.messages?.length
            ? table(['colMsg', 'colFlow', 'colDelivery', 'colTime'], bridge.messages.map(m => h('tr', { key: m.message_id },
                h('td', null, m.msg_type), h('td', null, `${m.sender_instance_id || '—'} → ${m.target_instance_id || '广播'}`),
                h('td', null, m.delivery_state), h('td', null, clock(m.created_at)))))
            : empty('messages'),
          h('h4', null, t('colWorkspace')),
          bridge.workspaces?.length
            ? table(['colWorkspace', 'colPath', 'colLease'], bridge.workspaces.map(w => h('tr', { key: w.workspace_id },
                h('td', null, w.workspace_id), h('td', null, h('code', null, w.path)), h('td', null, w.writable ? '✓' : '—'))))
            : empty('workspaces'),
          h('h4', null, t('colAgent')),
          bridge.agents?.length
            ? table(['colAgent', 'colVersion', 'colCaps', 'colLastSeen'], bridge.agents.map(a => h('tr', { key: a.instance_id },
                h('td', null, a.agent_id), h('td', null, a.version || '—'),
                h('td', null, h('code', null, Object.keys(a.capabilities || {}).join(', ') || '—')),
                h('td', null, clock(a.last_seen_at)))))
            : empty('agents'))),

      h('div', { className: 'mcp-card' },
        h('h3', null, t('chHttp')),
        h('strong', { 'data-mcp-http-state': http ? (http.online ? 'online' : 'offline') : 'unknown' },
          t(http ? (http.online ? 'online' : 'offline') : 'unknown')),
        h('p', null, t('httpNote')),
        http?.url && h('label', null, t('endpoint'), h('input', { readOnly: true, value: http.url, 'aria-label': t('endpoint') }))),

      h('div', { className: 'mcp-card' },
        h('h3', null, t('chMcp')),
        h('strong', { 'data-mcp-state': status ? (status.running ? 'online' : 'offline') : 'unknown' }, t(status ? (status.running ? 'online' : 'offline') : 'unknown')),
        h('div', { className: 'mcp-actions' }, button('refresh'), button('check', 'check', !status?.running), busy && h('span', null, t('checking'))),
        h('label', null, t('endpoint'), h('input', { readOnly: true, value: status?.url || '', 'aria-label': t('endpoint') })),
        h('div', { className: 'mcp-actions' }, button('copyUrl', 'copyUrl', !status?.url)),
        h('p', null, `${t('transport')}: Streamable HTTP`), h('p', null, t('mode')),
        status && h('p', null, `${t('limits')}: ${status.timeoutMs} / ${status.maxTasks}`)),
      h('div', { className: 'mcp-card' }, h('h3', null, t('token')), h('p', null, t('secret')),
        h('input', { readOnly: true, value: secret || '••••••••••••••••', 'aria-label': t('token'), autoComplete: 'off', spellCheck: false }),
        h('div', { className: 'mcp-actions' }, secret || manual ? h('button', { type: 'button', 'data-mcp-action': 'hide', onClick: clearSecrets }, t('hide')) : button('reveal', 'reveal', !status?.running),
          button('copyToken', 'copyToken', !status?.running), button('copyConfig', 'copyConfig', !status?.running))),
      h('div', { role: 'status', 'aria-live': 'polite', className: error ? 'mcp-error' : '' }, notice),
      manual && h('label', null, t('manual'), h('textarea', { readOnly: true, rows: 7, value: manual, 'data-mcp-manual': true })),
      h('h3', null, t('local')),
      h('h3', null, t('tools')), h('ul', null, ...(status?.tools || []).map((tool, i) => h('li', { key: tool.name }, h('code', null, tool.name), ' — ', t('t' + i)))))
  }
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-mcp: locale')
    const t = ctx.locale.bind(NS)
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.dshAgentMcp = '1'; style.textContent = css; document.head.append(style); return () => style.remove() }, 'agent-mcp: styles')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-mcp', order: 20,
      label: () => t('nav'), locale: NS, inject: () => ({ t }) }, Settings))
  }
  return { apply, inject: ['locale', 'slots'] }
} })