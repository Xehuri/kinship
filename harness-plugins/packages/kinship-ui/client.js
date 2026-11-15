/**
 * Browser half of the Kinship integration: the Kinship panel in the dsh Web
 * sidebar.
 *
 * The panel is a view over the `kinship-bridge` row's owner-facing JSON API
 * (`/api/kinship/ui/*`, registered on the dsh Connection's authenticated Fetch
 * channel), so this package holds no Host state and never rewrites a profile
 * patch itself. It ships as a separate Loader row from the bridge on purpose:
 * saving bridge configuration reloads the bridge row, and a browser module bound
 * to that row would unmount while the panel's own save was still settling.
 *
 * Built by hand in the Client module's lazy-CJS format: the bundle registers a
 * factory whose id equals the package name, and everything it needs at runtime
 * comes from the browser module table (`react`) plus the Cordis services named
 * in `inject`.
 */
window.__ModuleLoader__.load({
  id: 'kinship-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Sidebar row id; it also addresses the `main` keyed slot entry. */
    const PANEL_ID = 'kinship'
    /** Locale namespace of every string this bundle renders. */
    const NS = 'kinship.ui'
    /** Panel API routes, resolved against the document base like the host does. */
    const ROUTES = {
      state: 'api/kinship/ui/state',
      config: 'api/kinship/ui/config',
      token: 'api/kinship/ui/token',
      bind: 'api/kinship/ui/bind',
    }
    /** Poll delay after a save: the bridge row reloads and rebinds its listener. */
    const AFTER_SAVE_REFRESH_MS = 1200

    const zh = {
      panel: 'Kinship',
      'page.title': 'Kinship',
      'page.subtitle': 'DeepSeek Harness 侧的 Kinship 接入：桥接状态、配置与绑定会话',
      'action.refresh': '刷新',
      'action.save': '保存配置',
      'action.saving': '保存中',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.reveal': '显示令牌',
      'action.hide': '隐藏令牌',
      'action.rotate': '轮换令牌',
      'action.rotateConfirm': '确认轮换',
      'action.cancel': '取消',
      'action.bind': '绑定此会话',
      'action.bound': '当前绑定',
      'state.loading': '正在读取桥接状态',
      'state.loadFailed': '读取桥接状态失败',
      'state.unreachable': '桥接插件未响应。确认 kinship-bridge 已启用且 dsh 正在运行。',
      'status.title': '桥接状态',
      'status.url': '桥接地址',
      'status.version': '桥接版本',
      'status.dsh': 'Harness 版本',
      'status.binding': '绑定状态',
      'status.session': '绑定会话',
      'status.none': '未绑定',
      'binding.bound': '已绑定',
      'binding.unbound': '未绑定',
      'binding.missing': '绑定会话已丢失',
      'session.title': '标题',
      'session.id': '会话 ID',
      'session.cwd': '工作目录',
      'session.preset': '预设',
      'session.created': '创建时间',
      'session.status': '运行状态',
      'session.running': '运行中',
      'session.idle': '空闲',
      'token.title': '访问令牌',
      'token.note': 'Kinship 后端用同一令牌访问桥接。令牌只在点击「显示令牌」后出现在页面上。',
      'token.source': '来源',
      'token.source.env': '环境变量',
      'token.source.file': '密钥文件',
      'token.source.generated': '自动生成文件',
      'token.length': '长度',
      'token.hidden': '未显示',
      'token.revealed': '已显示',
      'config.title': '桥接配置',
      'config.note': '保存后写入当前 profile 的插件配置并立即重载桥接。',
      'config.host': '监听地址',
      'config.port': '监听端口',
      'config.policy': '绑定策略',
      'config.policy.first': '自动绑定最早的 kinship 会话',
      'config.policy.manual': '仅手动绑定',
      'config.sessionId': '启动时绑定的会话 ID',
      'config.rebindOnMissing': '绑定会话消失后自动改绑',
      'config.on': '已开启',
      'config.off': '已关闭',
      'config.bodyLimit': '请求体上限（字节）',
      'config.tokenEnv': '令牌环境变量',
      'config.tokenFile': '令牌文件路径',
      'config.unsaved': '有未保存的修改',
      'config.saved': '配置已保存，桥接正在重载',
      'config.readOnly': '当前部署无法保存配置，页面只读。',
      'sessions.title': '可选会话',
      'sessions.note': '只列出运行 kinship 预设的根会话。',
      'sessions.empty': '当前没有运行 kinship 预设的根会话',
      'snippet.title': '接入 Kinship',
      'snippet.note': '把下面这段写入 kinship 侧 config.yaml（或对应的配置项）即可连到本桥接。',
      'snippet.placeholder': '<点击上方「显示令牌」后粘贴>',
      'snippet.comment': '# kinship 侧 config.yaml',
    }

    const en = {
      panel: 'Kinship',
      'page.title': 'Kinship',
      'page.subtitle': 'Kinship on this DeepSeek Harness: bridge status, settings, and the bound Session',
      'action.refresh': 'Refresh',
      'action.save': 'Save configuration',
      'action.saving': 'Saving',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.reveal': 'Reveal token',
      'action.hide': 'Hide token',
      'action.rotate': 'Rotate token',
      'action.rotateConfirm': 'Confirm rotation',
      'action.cancel': 'Cancel',
      'action.bind': 'Bind this Session',
      'action.bound': 'Bound now',
      'state.loading': 'Reading bridge status',
      'state.loadFailed': 'Could not read the bridge status',
      'state.unreachable': 'The bridge plugin did not answer. Check that kinship-bridge is enabled and dsh is running.',
      'status.title': 'Bridge status',
      'status.url': 'Bridge URL',
      'status.version': 'Bridge version',
      'status.dsh': 'Harness version',
      'status.binding': 'Binding',
      'status.session': 'Bound Session',
      'status.none': 'None',
      'binding.bound': 'Bound',
      'binding.unbound': 'Unbound',
      'binding.missing': 'Bound Session is gone',
      'session.title': 'Title',
      'session.id': 'Session ID',
      'session.cwd': 'Working directory',
      'session.preset': 'Preset',
      'session.created': 'Created',
      'session.status': 'Agent status',
      'session.running': 'Running',
      'session.idle': 'Idle',
      'token.title': 'Bearer token',
      'token.note': 'The Kinship backend uses this token to reach the bridge. The value appears here only after you reveal it.',
      'token.source': 'Source',
      'token.source.env': 'Environment variable',
      'token.source.file': 'Secret file',
      'token.source.generated': 'Generated file',
      'token.length': 'Length',
      'token.hidden': 'Hidden',
      'token.revealed': 'Revealed',
      'config.title': 'Bridge configuration',
      'config.note': 'Saving writes the active profile’s plugin configuration and reloads the bridge immediately.',
      'config.host': 'Listen address',
      'config.port': 'Listen port',
      'config.policy': 'Binding policy',
      'config.policy.first': 'Bind the earliest kinship Session',
      'config.policy.manual': 'Manual binding only',
      'config.sessionId': 'Session id bound at startup',
      'config.rebindOnMissing': 'Rebind when the bound Session disappears',
      'config.on': 'On',
      'config.off': 'Off',
      'config.bodyLimit': 'Request body limit (bytes)',
      'config.tokenEnv': 'Token environment variable',
      'config.tokenFile': 'Token file path',
      'config.unsaved': 'Unsaved changes',
      'config.saved': 'Configuration saved; the bridge is reloading',
      'config.readOnly': 'This deployment cannot save configuration, so the panel is read-only.',
      'sessions.title': 'Bindable Sessions',
      'sessions.note': 'Only root Sessions running the kinship preset appear here.',
      'sessions.empty': 'No root Session is running the kinship preset',
      'snippet.title': 'Connect Kinship',
      'snippet.note': 'Add this to the Kinship side’s config.yaml, or to the equivalent configuration keys.',
      'snippet.placeholder': '<reveal the token above, then paste it here>',
      'snippet.comment': '# Kinship side: config.yaml',
    }

    /** Resolve one panel API route against the document base. */
    function endpoint(route) {
      return new URL(route, document.baseURI).toString()
    }

    /**
     * Call one JSON route and return its body; a failure carries the Host's
     * sentence so the panel never invents its own diagnosis.
     */
    async function callJson(route, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      let response
      try {
        response = await fetch(endpoint(route), { credentials: 'same-origin', ...init })
      } catch (error) {
        throw new Error(String(error && error.message ? error.message : error))
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const message = payload && payload.error && payload.error.message
        const code = payload && payload.error && payload.error.code
        const failure = new Error(message ? String(message) : 'HTTP ' + String(response.status))
        failure.code = code ? String(code) : undefined
        failure.status = response.status
        throw failure
      }
      return payload
    }

    /** Copy text with a fallback for browsers without the async clipboard. */
    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
      const holder = document.createElement('textarea')
      holder.value = text
      holder.setAttribute('readonly', '')
      holder.style.position = 'fixed'
      holder.style.opacity = '0'
      document.body.appendChild(holder)
      holder.select()
      document.execCommand('copy')
      document.body.removeChild(holder)
    }

    /** Human time for the bound Session's creation stamp. */
    function formatTime(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    /** Row helper: one label/value pair inside a card's grid. */
    function Row({ label, children }) {
      return h(React.Fragment, null,
        h('div', { className: 'kui-label' }, label),
        h('div', { className: 'kui-value' }, children))
    }

    /** Card shell with an optional action cluster in its head. */
    function Card({ title, actions, children }) {
      return h('section', { className: 'kui-card' },
        h('div', { className: 'kui-card-head' },
          h('h2', { className: 'kui-card-title' }, title),
          actions === undefined ? null : h('div', { className: 'kui-actions' }, actions)),
        children)
    }

    const styles = [
      '.kui-page{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}',
      '.kui-scroll{flex:1;min-height:0;overflow:auto;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}',
      '.kui-content{max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px;display:flex;flex-direction:column;gap:16px}',
      '@media (max-width:767px){.kui-content{padding-inline:20px}}',
      '.kui-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.kui-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.01em}',
      '.kui-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px}',
      '.kui-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.kui-button{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
      '.kui-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.kui-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.kui-button:disabled{opacity:.5;cursor:default}',
      '.kui-button-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.kui-button-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);filter:brightness(1.06)}',
      '.kui-button-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}',
      '.kui-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform);padding:16px;display:flex;flex-direction:column;gap:12px}',
      '.kui-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.kui-card-title{margin:0;font-size:14px;font-weight:600}',
      '.kui-rows{display:grid;grid-template-columns:minmax(110px,170px) minmax(0,1fr);gap:8px 16px;align-items:baseline}',
      '.kui-label{color:var(--dsw-alias-label-tertiary);font-size:13px}',
      '.kui-value{font-size:13px;word-break:break-all}',
      '.kui-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.kui-form{display:grid;grid-template-columns:minmax(140px,200px) minmax(0,1fr);gap:12px 16px;align-items:center}',
      '.kui-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.kui-input{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.kui-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.kui-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.kui-inline{display:flex;align-items:center;gap:8px}',
      '.kui-checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary)}',
      '.kui-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.kui-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}',
      '.kui-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}',
      '.kui-badge-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}',
      '.kui-alert{border-radius:10px;padding:10px 12px;font-size:13px;border:1px solid var(--dsw-alias-border-l2)}',
      '.kui-alert-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
      '.kui-alert-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}',
      '.kui-snippet{margin:0;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all}',
      '.kui-session{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.kui-session:first-of-type{border-top:0}',
      '.kui-session-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.kui-session-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.kui-session-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-all}',
      '@media (max-width:559px){.kui-rows,.kui-form{grid-template-columns:minmax(0,1fr);gap:4px 0}.kui-row-gap,.kui-label{margin-top:10px}.kui-rows>.kui-label:first-child,.kui-form>.kui-label:first-child{margin-top:0}}',
    ].join('')

    /** Decorative sidebar glyph: three linked nodes. */
    function KinshipIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M5.2 10.6 10.4 4.9' }),
        h('path', { d: 'M10.9 11.5 13.1 10.4' }),
        h('circle', { cx: 4, cy: 12, r: 1.7 }),
        h('circle', { cx: 11.4, cy: 4, r: 1.7 }),
        h('circle', { cx: 13.2, cy: 11.4, r: 1.5 }))
    }

    /** One labelled control in the configuration grid. */
    function Field({ label, hint, children }) {
      return h(React.Fragment, null,
        h('div', { className: 'kui-label' }, label),
        h('div', { className: 'kui-field' }, children, hint === undefined ? null : h('span', { className: 'kui-hint' }, hint)))
    }

    /**
     * The Kinship page: bridge status, token handling, editable configuration,
     * the live Session catalog, and the snippet the Kinship side needs.
     */
    function KinshipPanel({ t }) {
      const [snapshot, setSnapshot] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [loadError, setLoadError] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [token, setToken] = useState(null)
      const [confirmingRotate, setConfirmingRotate] = useState(false)
      const [copied, setCopied] = useState(null)
      const alive = useRef(true)

      useEffect(() => () => { alive.current = false }, [])

      const load = useCallback(async (quiet) => {
        if (!quiet) setPhase(current => current === 'ready' ? current : 'loading')
        try {
          const next = await callJson(ROUTES.state)
          if (!alive.current) return
          setSnapshot(next)
          setDraft(next.config)
          setLoadError(null)
          setPhase('ready')
        } catch (error) {
          if (!alive.current) return
          setLoadError(error instanceof Error ? error.message : String(error))
          setPhase('error')
        }
      }, [])

      useEffect(() => { void load(false) }, [load])

      const dirty = useMemo(() => {
        if (snapshot === null || draft === null) return false
        return Object.keys(draft).some(key => draft[key] !== snapshot.config[key])
      }, [snapshot, draft])

      const update = useCallback((field, value) => {
        setDraft(current => current === null ? current : { ...current, [field]: value })
      }, [])

      const save = useCallback(async () => {
        if (draft === null) return
        setBusy('save')
        setNotice(null)
        try {
          await callJson(ROUTES.config, { config: draft })
          if (!alive.current) return
          setNotice({ kind: 'ok', text: t('config.saved') })
          window.setTimeout(() => { void load(true) }, AFTER_SAVE_REFRESH_MS)
        } catch (error) {
          if (!alive.current) return
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [draft, load, t])

      const reveal = useCallback(async () => {
        setBusy('token')
        setNotice(null)
        try {
          const answer = await callJson(ROUTES.token, { action: 'reveal' })
          if (!alive.current) return
          setToken(answer && typeof answer.token === 'string' ? answer.token : null)
        } catch (error) {
          if (!alive.current) return
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [])

      const rotate = useCallback(async () => {
        setBusy('rotate')
        setNotice(null)
        try {
          const answer = await callJson(ROUTES.token, { action: 'rotate' })
          if (!alive.current) return
          setToken(answer && typeof answer.token === 'string' ? answer.token : null)
          setConfirmingRotate(false)
          await load(true)
        } catch (error) {
          if (!alive.current) return
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [load])

      const bind = useCallback(async (sessionId) => {
        setBusy('bind:' + sessionId)
        setNotice(null)
        try {
          await callJson(ROUTES.bind, { sessionId })
          if (!alive.current) return
          await load(true)
        } catch (error) {
          if (!alive.current) return
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [load])

      const copy = useCallback(async (kind, text) => {
        try {
          await copyText(text)
          if (!alive.current) return
          setCopied(kind)
          window.setTimeout(() => { if (alive.current) setCopied(current => current === kind ? null : current) }, 1800)
        } catch (error) {
          if (!alive.current) return
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      const bindingLabel = snapshot === null
        ? ''
        : snapshot.binding.status === 'bound'
          ? t('binding.bound')
          : snapshot.binding.status === 'bound_session_missing' ? t('binding.missing') : t('binding.unbound')
      const bindingTone = snapshot === null
        ? 'kui-badge'
        : snapshot.binding.status === 'bound' ? 'kui-badge kui-badge-ok' : 'kui-badge kui-badge-warn'

      const snippet = snapshot === null ? '' : [
        t('snippet.comment'),
        'ai_backend: dsh',
        'dsh:',
        '  url: ' + String(snapshot.bridge.url),
        '  token: ' + (token === null ? t('snippet.placeholder') : token),
      ].join('\n')

      const head = h('header', { className: 'kui-head' },
        h('div', null,
          h('h1', { className: 'kui-title' }, t('page.title')),
          h('p', { className: 'kui-sub' }, t('page.subtitle'))),
        h('div', { className: 'kui-actions' },
          h('button', {
            type: 'button',
            className: 'kui-button',
            onClick: () => { void load(false) },
            disabled: busy !== null,
          }, t('action.refresh'))))

      const noticeNode = notice === null
        ? null
        : h('div', { className: notice.kind === 'ok' ? 'kui-alert kui-alert-ok' : 'kui-alert kui-alert-error', role: 'status' }, notice.text)

      if (phase === 'loading') {
        return h('div', { className: 'kui-page' },
          h('style', null, styles),
          h('div', { className: 'kui-scroll' },
            h('div', { className: 'kui-content' }, head,
              h('div', { className: 'kui-card' }, t('state.loading')))),
          noticeNode)
      }

      if (phase === 'error' || snapshot === null || draft === null) {
        const detail = loadError === null ? t('state.unreachable') : loadError
        return h('div', { className: 'kui-page' },
          h('style', null, styles),
          h('div', { className: 'kui-scroll' },
            h('div', { className: 'kui-content' }, head,
              h('div', { className: 'kui-alert kui-alert-error', role: 'alert' },
                h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('state.loadFailed')),
                h('div', null, detail),
                h('div', { className: 'kui-actions', style: { marginTop: 10 } },
                  h('button', {
                    type: 'button',
                    className: 'kui-button',
                    onClick: () => { void load(false) },
                  }, t('action.refresh')))))),
          noticeNode)
      }

      const session = snapshot.session
      const sessionRows = snapshot.sessions.length === 0
        ? [h('div', { key: 'empty', className: 'kui-hint' }, t('sessions.empty'))]
        : snapshot.sessions.map(row => h('div', { key: row.id, className: 'kui-session' },
          h('div', { className: 'kui-session-main' },
            h('div', { className: 'kui-session-title' }, row.title === null ? row.id : row.title),
            h('div', { className: 'kui-session-meta kui-mono' }, row.id),
            h('div', { className: 'kui-session-meta' },
              (row.status === 'running' ? t('session.running') : t('session.idle')) + ' · ' + formatTime(row.createdAt))),
          h('div', { className: 'kui-actions' },
            row.bound
              ? h('span', { className: 'kui-badge kui-badge-ok' }, t('action.bound'))
              : h('button', {
                type: 'button',
                className: 'kui-button',
                disabled: busy !== null,
                onClick: () => { void bind(row.id) },
              }, t('action.bind')))))

      const cards = [
        h(Card, { key: 'status', title: t('status.title') },
          h('div', { className: 'kui-rows' },
            h(Row, { label: t('status.url') },
              h('span', { className: 'kui-mono' }, snapshot.bridge.url)),
            h(Row, { label: t('status.binding') },
              h('span', { className: bindingTone }, bindingLabel)),
            h(Row, { label: t('status.version') },
              h('span', { className: 'kui-mono' }, snapshot.bridge.version + ' · dsh ' + snapshot.bridge.dsh)),
            session === null
              ? h(Row, { key: 'none', label: t('status.session') }, t('status.none'))
              : h(React.Fragment, { key: 'bound' },
                h(Row, { key: 'title', label: t('session.title') }, session.title === null ? t('status.none') : session.title),
                h(Row, { key: 'id', label: t('session.id') }, h('span', { className: 'kui-mono' }, session.id)),
                h(Row, { key: 'cwd', label: t('session.cwd') }, h('span', { className: 'kui-mono' }, session.cwd === null ? '—' : session.cwd)),
                h(Row, { key: 'agent', label: t('session.status') },
                  h('span', null, session.status === 'running' ? t('session.running') : t('session.idle')))))),

        h(Card, { key: 'token', title: t('token.title') },
          h('div', { className: 'kui-rows' },
            h(Row, { label: t('token.source') },
              h('span', null,
                snapshot.token.source === 'env'
                  ? t('token.source.env') + ' · ' + String(snapshot.token.env)
                  : snapshot.token.source === 'file'
                    ? t('token.source.file') + ' · ' + String(snapshot.token.path)
                    : t('token.source.generated') + ' · ' + String(snapshot.token.path))),
            h(Row, { label: t('token.length') }, String(snapshot.token.length)),
            h(Row, { label: token === null ? t('token.hidden') : t('token.revealed') },
              token === null
                ? h('span', { className: 'kui-mono' }, '••••••••')
                : h('div', { className: 'kui-inline' },
                  h('span', { className: 'kui-mono' }, token),
                  h('button', {
                    type: 'button',
                    className: 'kui-button',
                    onClick: () => { void copy('token', token) },
                  }, copied === 'token' ? t('action.copied') : t('action.copy'))))),
          h('div', { className: 'kui-hint' }, t('token.note')),
          h('div', { className: 'kui-actions' },
            token === null
              ? h('button', {
                type: 'button',
                className: 'kui-button',
                disabled: busy !== null,
                onClick: () => { void reveal() },
              }, t('action.reveal'))
              : h('button', {
                type: 'button',
                className: 'kui-button',
                onClick: () => { setToken(null) },
              }, t('action.hide')),
            confirmingRotate
              ? h(React.Fragment, null,
                h('button', {
                  type: 'button',
                  className: 'kui-button kui-button-danger',
                  disabled: busy !== null,
                  onClick: () => { void rotate() },
                }, t('action.rotateConfirm')),
                h('button', {
                  type: 'button',
                  className: 'kui-button',
                  disabled: busy !== null,
                  onClick: () => { setConfirmingRotate(false) },
                }, t('action.cancel')))
              : h('button', {
                type: 'button',
                className: 'kui-button',
                disabled: busy !== null,
                onClick: () => { setConfirmingRotate(true) },
              }, t('action.rotate')))),

        h(Card, { key: 'config', title: t('config.title') },
          h('div', { className: 'kui-form' },
            h(Field, { label: t('config.host') },
              h('input', {
                className: 'kui-input kui-mono',
                value: draft.host,
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('host', event.target.value) },
              })),
            h(Field, { label: t('config.port') },
              h('input', {
                className: 'kui-input kui-mono',
                type: 'number',
                min: 0,
                max: 65535,
                value: String(draft.port),
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('port', Number(event.target.value)) },
              })),
            h(Field, { label: t('config.policy') },
              h('select', {
                className: 'kui-input',
                value: draft.policy,
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('policy', event.target.value) },
              },
                h('option', { value: 'first' }, t('config.policy.first')),
                h('option', { value: 'manual' }, t('config.policy.manual')))),
            h(Field, { label: t('config.sessionId') },
              h('input', {
                className: 'kui-input kui-mono',
                value: draft.sessionId,
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('sessionId', event.target.value) },
              })),
            h(Field, { label: t('config.rebindOnMissing') },
              h('label', { className: 'kui-inline' },
                h('input', {
                  className: 'kui-checkbox',
                  type: 'checkbox',
                  checked: draft.rebindOnMissing === true,
                  disabled: !snapshot.editable || busy !== null,
                  onChange: event => { update('rebindOnMissing', event.target.checked) },
                }),
                h('span', { className: 'kui-hint' }, draft.rebindOnMissing === true ? t('config.on') : t('config.off')))),
            h(Field, { label: t('config.bodyLimit') },
              h('input', {
                className: 'kui-input kui-mono',
                type: 'number',
                min: 1,
                max: 1048576,
                value: String(draft.bodyLimitBytes),
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('bodyLimitBytes', Number(event.target.value)) },
              })),
            h(Field, { label: t('config.tokenEnv') },
              h('input', {
                className: 'kui-input kui-mono',
                value: draft.tokenEnv,
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('tokenEnv', event.target.value) },
              })),
            h(Field, { label: t('config.tokenFile') },
              h('input', {
                className: 'kui-input kui-mono',
                value: draft.tokenFile,
                disabled: !snapshot.editable || busy !== null,
                onChange: event => { update('tokenFile', event.target.value) },
              }))),
          h('div', { className: 'kui-hint' }, snapshot.editable ? t('config.note') : t('config.readOnly')),
          h('div', { className: 'kui-actions' },
            h('button', {
              type: 'button',
              className: 'kui-button kui-button-primary',
              disabled: !snapshot.editable || !dirty || busy !== null,
              onClick: () => { void save() },
            }, busy === 'save' ? t('action.saving') : t('action.save')),
            dirty ? h('span', { className: 'kui-hint' }, t('config.unsaved')) : null)),

        h(Card, { key: 'sessions', title: t('sessions.title') },
          h('div', { className: 'kui-hint' }, t('sessions.note')),
          sessionRows),

        h(Card, {
          key: 'snippet',
          title: t('snippet.title'),
          actions: h('button', {
            type: 'button',
            className: 'kui-button',
            onClick: () => { void copy('snippet', snippet) },
          }, copied === 'snippet' ? t('action.copied') : t('action.copy')),
        },
          h('div', { className: 'kui-hint' }, t('snippet.note')),
          h('pre', { className: 'kui-snippet' }, snippet)),
      ]

      return h('div', { className: 'kui-page' },
        h('style', null, styles),
        h('div', { className: 'kui-scroll' },
          h('div', { className: 'kui-content' }, head, noticeNode, cards)))
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kinship-ui: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, KinshipPanel)), 'kinship-ui: panel page')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 12,
          locale: NS,
          label: () => t('panel'),
        }, KinshipIcon)), 'kinship-ui: sidebar row')
      },
    }
  },
})
