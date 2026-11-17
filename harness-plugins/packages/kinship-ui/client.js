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
      plan: 'api/kinship/ui/plan',
      planOps: 'api/kinship/ui/plan/ops',
      planReconcile: 'api/kinship/ui/plan/reconcile',
      planSeed: 'api/kinship/ui/plan/seed',
    }
    /** Poll delay after a save: the bridge row reloads and rebinds its listener. */
    const AFTER_SAVE_REFRESH_MS = 1200
    /** `HH:MM` wall clock the scheduler's schedule objects carry. */
    const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
    /** Locale keys of the weekday labels, indexed like `Intl` (0 = Sunday). */
    const WEEKDAY_KEYS = [
      'plan.week.sun',
      'plan.week.mon',
      'plan.week.tue',
      'plan.week.wed',
      'plan.week.thu',
      'plan.week.fri',
      'plan.week.sat',
    ]
    /** Weekday tokens the master schedule schema accepts, in display order. */
    const WEEKDAY_OPTIONS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    /** Weekday tokens of the master schedule schema and their `Intl` index. */
    const WEEKDAY_INDEX = {
      sun: 0,
      sunday: 0,
      mon: 1,
      monday: 1,
      tue: 2,
      tues: 2,
      tuesday: 2,
      wed: 3,
      wednesday: 3,
      thu: 4,
      thur: 4,
      thurs: 4,
      thursday: 4,
      fri: 5,
      friday: 5,
      sat: 6,
      saturday: 6,
    }
    /** Plan-root candidates the scheduler reports, in its own precedence order. */
    const ROOT_SOURCE_IDS = ['pushed', 'config', 'env', 'default']
    /** Anchor origins the scheduler reports; an unknown value renders as default. */
    const ANCHOR_SOURCE_IDS = ['config', 'master', 'default']
    /**
     * 面板顶部的 tab 顺序，也是卡片分组的固定划分：
     * 概览=状态+会话，排异=IsolationCard，计划=PlanScheduleCard，
     * 接入=令牌+接入片段，设置=桥接配置。
     */
    const TAB_IDS = ['overview', 'isolation', 'plan', 'access', 'settings']
    /** DOM id 前缀，把 tab 按钮与它控制的面板关联起来（aria-controls）。 */
    const TAB_ELEMENT_ID = 'kui-tab-'
    const TAB_PANEL_ID = 'kui-tabpanel-'

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
      'tab.label': '面板分区',
      'tab.overview': '概览',
      'tab.isolation': '排异',
      'tab.plan': '计划',
      'tab.access': '接入',
      'tab.settings': '设置',
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
      'isolation.title': '排异状态',
      'isolation.note': 'kinship-isolation 在 kinship 预设作用域里遮蔽 host 提示词段、并按前缀限制 host 工具；下面显示它最近一次上报的结果。',
      'isolation.missing': '排异未激活（未收到 kinship-isolation 报告）',
      'isolation.state': '状态',
      'isolation.active': '已生效',
      'isolation.inactive': '未生效',
      'isolation.preset': '预设',
      'isolation.updated': '上报时间',
      'isolation.sections': '提示词段',
      'isolation.sections.empty': '没有需要遮蔽的段',
      'isolation.section.shadowed': '已注册遮蔽段',
      'isolation.section.unshadowed': '未注册',
      'isolation.tools': '工具限制',
      'isolation.tools.empty': '没有配置工具前缀',
      'isolation.tools.denied': '已限制 {count} 个：{names}',
      'isolation.tools.pending': '等待工具注册',
      'isolation.tools.none': '未发现匹配工具',
      'isolation.errors': '错误',
      'snippet.title': '接入 Kinship',
      'snippet.note': '把下面这段写入 kinship 侧 config.yaml（或对应的配置项）即可连到本桥接。',
      'snippet.placeholder': '<点击上方「显示令牌」后粘贴>',
      'snippet.comment': '# kinship 侧 config.yaml',
      'plan.title': '计划排班',
      'plan.mode': '模式',
      'plan.mode.live': '实时',
      'plan.mode.shadow': '影子',
      'plan.mode.off': '关闭',
      'plan.planRoot': '计划根目录',
      'plan.planRoot.unset': '未解析',
      'plan.stateDir': '状态目录',
      'plan.timezone': '时区',
      'plan.anchors': '对账锚点',
      'plan.anchors.empty': '未配置',
      'plan.source.pushed': '来源：kinship 后端推送（{stamp}）',
      'plan.source.config': '来源：插件配置',
      'plan.source.env': '来源：env',
      'plan.source.default': '来源：默认（等待 kinship 后端推送）',
      'plan.source.unresolved': '未解析',
      'plan.source.pushedProblem': '路径推送有问题：{problem}',
      'plan.anchorsSource.config': '来自配置',
      'plan.anchorsSource.master': '来自母版',
      'plan.anchorsSource.default': '默认',
      'plan.timezoneSource.master': '来自母版',
      'plan.timezoneSource.config': '来自配置',
      'plan.problem': '计划根目录不可用',
      'plan.degraded': '调度器已降级',
      'plan.lastError': '最近错误',
      'plan.next': '下次唤醒',
      'plan.none': '无',
      'plan.loading': '正在读取计划排班',
      'plan.missing': '计划调度器未安装或未启用',
      'plan.loadFailed': '读取计划排班失败',
      'plan.master': '主排班表',
      'plan.master.version': '版本',
      'plan.master.updated': '更新于',
      'plan.master.unreadable': '主排班表存在但无法读取。',
      'plan.uninitialized': '未初始化',
      'plan.uninitializedHint': '还没有主排班表。创建默认排班后即可在这里编辑。',
      'plan.seed': '创建默认排班',
      'plan.seeding': '正在创建',
      'plan.seeded': '已创建默认排班',
      'plan.empty': '主排班表没有条目',
      'plan.column.time': '时间',
      'plan.column.kind': '类型',
      'plan.column.action': '动作',
      'plan.column.title': '标题',
      'plan.column.enabled': '启用',
      'plan.column.next': '下次唤醒',
      'plan.column.actions': '操作',
      'plan.delete': '删除',
      'plan.deleteConfirm': '确认删除',
      'plan.updated': '已更新排班',
      'plan.deleted': '已删除条目',
      'plan.add': '添加条目',
      'plan.addHint': '新条目按 fixed 类型写入；动作留空时使用调度器默认动作。',
      'plan.field.id': 'ID',
      'plan.field.title': '标题',
      'plan.field.action': '动作（可选）',
      'plan.field.actionHint': '可选，留空则用默认动作',
      'plan.field.at': '时间 HH:MM',
      'plan.field.kind': '重复类型',
      'plan.field.weekday': '星期',
      'plan.kind.daily': '每日',
      'plan.kind.weekly': '每周',
      'plan.kind.monthly': '每月',
      'plan.addSubmit': '添加',
      'plan.added': '已添加条目',
      'plan.invalidTime': '时间格式应为 HH:MM',
      'plan.invalidId': 'ID 不能为空',
      'plan.invalidTitle': '标题不能为空',
      'plan.saveFailed': '保存排班失败',
      'plan.conflict': '排班表已被其他写入方修改，请刷新后重试',
      'plan.reconcile': '立即对账',
      'plan.reconciling': '对账中',
      'plan.reconciled': '对账完成',
      'plan.reconcileFailed': '对账失败',
      'plan.count.added': '新增',
      'plan.count.updated': '更新',
      'plan.count.cancelled': '取消',
      'plan.queue': '唤醒队列',
      'plan.queue.pending': '待投递',
      'plan.queue.delivered': '最近投递',
      'plan.queue.empty': '队列为空',
      'plan.queue.session': '队列会话',
      'plan.week.mon': '星期一',
      'plan.week.tue': '星期二',
      'plan.week.wed': '星期三',
      'plan.week.thu': '星期四',
      'plan.week.fri': '星期五',
      'plan.week.sat': '星期六',
      'plan.week.sun': '星期日',
      'plan.daySeparator': '、',
      'plan.monthlyPrefix': '每月',
      'plan.monthlySuffix': '日',
      'plan.schedule.custom': '自定义时间',
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
      'tab.label': 'Panel sections',
      'tab.overview': 'Overview',
      'tab.isolation': 'Isolation',
      'tab.plan': 'Plan',
      'tab.access': 'Access',
      'tab.settings': 'Settings',
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
      'isolation.title': 'Isolation',
      'isolation.note': 'kinship-isolation shadows host prompt sections and restricts host tools by prefix inside the kinship preset; this shows its latest report.',
      'isolation.missing': 'Isolation is not active (no kinship-isolation report yet)',
      'isolation.state': 'State',
      'isolation.active': 'Active',
      'isolation.inactive': 'Inactive',
      'isolation.preset': 'Preset',
      'isolation.updated': 'Reported',
      'isolation.sections': 'Prompt sections',
      'isolation.sections.empty': 'No section needs shadowing',
      'isolation.section.shadowed': 'Shadow registered',
      'isolation.section.unshadowed': 'Not registered',
      'isolation.tools': 'Tool restrictions',
      'isolation.tools.empty': 'No tool prefix configured',
      'isolation.tools.denied': '{count} restricted: {names}',
      'isolation.tools.pending': 'Waiting for tool registration',
      'isolation.tools.none': 'No matching tool found',
      'isolation.errors': 'Errors',
      'snippet.title': 'Connect Kinship',
      'snippet.note': 'Add this to the Kinship side’s config.yaml, or to the equivalent configuration keys.',
      'snippet.placeholder': '<reveal the token above, then paste it here>',
      'snippet.comment': '# Kinship side: config.yaml',
      'plan.title': 'Plan schedule',
      'plan.mode': 'Mode',
      'plan.mode.live': 'Live',
      'plan.mode.shadow': 'Shadow',
      'plan.mode.off': 'Off',
      'plan.planRoot': 'Plan root',
      'plan.planRoot.unset': 'Unresolved',
      'plan.stateDir': 'State directory',
      'plan.timezone': 'Timezone',
      'plan.anchors': 'Reconcile anchors',
      'plan.anchors.empty': 'None configured',
      'plan.source.pushed': 'Source: kinship backend push ({stamp})',
      'plan.source.config': 'Source: plugin config',
      'plan.source.env': 'Source: env',
      'plan.source.default': 'Source: default (waiting for the kinship backend push)',
      'plan.source.unresolved': 'Unresolved',
      'plan.source.pushedProblem': 'Path push problem: {problem}',
      'plan.anchorsSource.config': 'From config',
      'plan.anchorsSource.master': 'From master',
      'plan.anchorsSource.default': 'Default',
      'plan.timezoneSource.master': 'From master',
      'plan.timezoneSource.config': 'From config',
      'plan.problem': 'Plan root is unusable',
      'plan.degraded': 'Scheduler is degraded',
      'plan.lastError': 'Last error',
      'plan.next': 'Next wake-up',
      'plan.none': 'None',
      'plan.loading': 'Reading the plan schedule',
      'plan.missing': 'The plan scheduler is not installed or not enabled',
      'plan.loadFailed': 'Could not read the plan schedule',
      'plan.master': 'Master schedule',
      'plan.master.version': 'Version',
      'plan.master.updated': 'updated',
      'plan.master.unreadable': 'The master schedule exists but cannot be read.',
      'plan.uninitialized': 'Not initialized',
      'plan.uninitializedHint': 'There is no master schedule yet. Create the default schedule to start editing it here.',
      'plan.seed': 'Create default schedule',
      'plan.seeding': 'Creating',
      'plan.seeded': 'Default schedule created',
      'plan.empty': 'The master schedule has no entries',
      'plan.column.time': 'Time',
      'plan.column.kind': 'Kind',
      'plan.column.action': 'Action',
      'plan.column.title': 'Title',
      'plan.column.enabled': 'Enabled',
      'plan.column.next': 'Next',
      'plan.column.actions': 'Actions',
      'plan.delete': 'Delete',
      'plan.deleteConfirm': 'Confirm delete',
      'plan.updated': 'Schedule updated',
      'plan.deleted': 'Entry deleted',
      'plan.add': 'Add entry',
      'plan.addHint': 'New entries are written as kind fixed; a blank action uses the scheduler default.',
      'plan.field.id': 'ID',
      'plan.field.title': 'Title',
      'plan.field.action': 'Action (optional)',
      'plan.field.actionHint': 'Optional; blank uses the default action',
      'plan.field.at': 'Time HH:MM',
      'plan.field.kind': 'Recurrence',
      'plan.field.weekday': 'Weekday',
      'plan.kind.daily': 'Daily',
      'plan.kind.weekly': 'Weekly',
      'plan.kind.monthly': 'Monthly',
      'plan.addSubmit': 'Add',
      'plan.added': 'Entry added',
      'plan.invalidTime': 'Time must be HH:MM',
      'plan.invalidId': 'ID is required',
      'plan.invalidTitle': 'Title is required',
      'plan.saveFailed': 'Could not save the schedule',
      'plan.conflict': 'Another writer changed the master schedule. Refresh and try again.',
      'plan.reconcile': 'Reconcile now',
      'plan.reconciling': 'Reconciling',
      'plan.reconciled': 'Reconcile finished',
      'plan.reconcileFailed': 'Reconcile failed',
      'plan.count.added': 'added',
      'plan.count.updated': 'updated',
      'plan.count.cancelled': 'cancelled',
      'plan.queue': 'Wake queue',
      'plan.queue.pending': 'Pending',
      'plan.queue.delivered': 'Recently delivered',
      'plan.queue.empty': 'The queue is empty',
      'plan.queue.session': 'Queue Session',
      'plan.week.mon': 'Mon',
      'plan.week.tue': 'Tue',
      'plan.week.wed': 'Wed',
      'plan.week.thu': 'Thu',
      'plan.week.fri': 'Fri',
      'plan.week.sat': 'Sat',
      'plan.week.sun': 'Sun',
      'plan.daySeparator': ', ',
      'plan.monthlyPrefix': 'Day',
      'plan.monthlySuffix': 'of the month',
      'plan.schedule.custom': 'Custom time',
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

    /** Epoch milliseconds or ISO stamp as human time; anything else verbatim. */
    function formatStamp(value) {
      if (typeof value === 'number' && value > 0) return formatTime(value)
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Date.parse(value)
        return Number.isNaN(parsed) ? value : formatTime(parsed)
      }
      return '—'
    }

    /** Plain object guard for every route payload this bundle reads. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** The Host's sentence, or a thrown value's text. */
    function describeError(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** HTTP status a failed `callJson` carries, or 0 when it never answered. */
    function errorStatus(error) {
      return isRecord(error) && typeof error.status === 'number' ? error.status : 0
    }

    function numberOrZero(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    /** `Intl` weekday index (0 = Sunday) of one schedule weekday token. */
    function weekdayNumber(value) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7) {
        return value === 7 ? 0 : value
      }
      if (typeof value === 'string') {
        const token = value.trim().toLowerCase()
        if (/^[0-7]$/.test(token)) return Number(token) === 7 ? 0 : Number(token)
        const named = WEEKDAY_INDEX[token]
        if (named !== undefined) return named
      }
      return null
    }

    /** Localized weekday label for one schedule weekday token. */
    function weekdayLabel(value, t) {
      const index = weekdayNumber(value)
      return index === null ? String(value) : t(WEEKDAY_KEYS[index])
    }

    /**
     * Local text of one master schedule object: `HH:MM` for daily,
     * `星期X HH:MM` for weekly, `每月 N 日 HH:MM` for monthly, and
     * `YYYY-MM-DD HH:MM` for once. Unknown shapes fall back to their clock.
     */
    function scheduleText(schedule, t) {
      if (!isRecord(schedule)) return '—'
      const clock = typeof schedule.at === 'string' ? schedule.at : ''
      const days = Array.isArray(schedule.days) ? schedule.days : []
      switch (schedule.kind) {
        case 'daily':
          return clock === '' ? '—' : clock
        case 'weekly': {
          const labels = days.map(day => weekdayLabel(day, t))
          const head = labels.length === 0 ? t('plan.kind.weekly') : labels.join(t('plan.daySeparator'))
          return clock === '' ? head : head + ' ' + clock
        }
        case 'monthly': {
          const labels = days.map(day => String(day))
          const head = labels.length === 0
            ? t('plan.kind.monthly')
            : t('plan.monthlyPrefix') + ' ' + labels.join(t('plan.daySeparator')) + ' ' + t('plan.monthlySuffix')
          return clock === '' ? head : head + ' ' + clock
        }
        case 'once': {
          const date = typeof schedule.date === 'string' ? schedule.date : ''
          return (date + ' ' + clock).trim() === '' ? t('plan.schedule.custom') : (date + ' ' + clock).trim()
        }
        default:
          return clock === '' ? t('plan.schedule.custom') : clock
      }
    }

    /** Copy of one master schedule with only its `HH:MM` clock replaced. */
    function scheduleWithClock(schedule, clock) {
      return { ...schedule, at: clock }
    }

    /** Localized text of the next wake-up row. */
    function nextWakeText(plan, t) {
      if (plan === null || plan.next === null) return t('plan.none')
      const local = typeof plan.next.local === 'string' ? plan.next.local : formatStamp(plan.next.at)
      const title = typeof plan.next.title === 'string' && plan.next.title !== '' ? plan.next.title : String(plan.next.id)
      return local + ' · ' + title
    }

    /**
     * Provenance sentence under the plan-root row: which candidate resolved it
     * and, for a backend push, when the last sync happened.
     */
    function planRootSourceText(scheduler, t) {
      switch (scheduler.planRootSource) {
        case 'pushed':
          return t('plan.source.pushed', { stamp: formatStamp(scheduler.pathsPushedAt) })
        case 'config':
          return t('plan.source.config')
        case 'env':
          return t('plan.source.env')
        case 'default':
          return t('plan.source.default')
        default:
          return t('plan.source.unresolved')
      }
    }

    /** Provenance sentence next to the anchors: config override, master, default. */
    function anchorsSourceText(scheduler, t) {
      switch (scheduler.anchorsSource) {
        case 'config':
          return t('plan.anchorsSource.config')
        case 'master':
          return t('plan.anchorsSource.master')
        default:
          return t('plan.anchorsSource.default')
      }
    }

    /**
     * Provenance sentence next to the timezone: the master owns it once one
     * exists, so an absent master means the plugin row's zone is in effect.
     */
    function timezoneSourceText(plan, t) {
      const master = plan === null ? null : plan.master
      const fromMaster = isRecord(master) && typeof master.timezone === 'string' && master.timezone !== ''
      return fromMaster ? t('plan.timezoneSource.master') : t('plan.timezoneSource.config')
    }

    /**
     * Coerce one route answer into the panel's plan view. The plan routes
     * answer with the GET shape (ops/seed) or `{ok, queued, snapshot}` where
     * the snapshot rides nested (reconcile), so both forms unwrap here.
     */
    function normalizePlanSnapshot(answer) {
      const direct = isRecord(answer) ? answer : {}
      const source = isRecord(direct.snapshot) ? direct.snapshot : direct
      const scheduler = isRecord(source.scheduler) ? source.scheduler : {}
      const master = isRecord(source.master) ? source.master : null
      const queue = isRecord(source.queue) ? source.queue : {}
      const anchors = Array.isArray(scheduler.anchors)
        ? scheduler.anchors.filter(clock => typeof clock === 'string')
        : []
      return {
        scheduler: {
          mode: scheduler.mode === 'shadow' || scheduler.mode === 'off' ? scheduler.mode : 'live',
          planRoot: typeof scheduler.planRoot === 'string' ? scheduler.planRoot : null,
          stateDir: typeof scheduler.stateDir === 'string' ? scheduler.stateDir : '',
          timezone: typeof scheduler.timezone === 'string' ? scheduler.timezone : '',
          anchors,
          planRootSource: ROOT_SOURCE_IDS.includes(scheduler.planRootSource)
            ? scheduler.planRootSource
            : null,
          pathsPushedAt: typeof scheduler.pathsPushedAt === 'number' ? scheduler.pathsPushedAt : null,
          pathsSource: typeof scheduler.pathsSource === 'string' ? scheduler.pathsSource : null,
          pathsProblem: typeof scheduler.pathsProblem === 'string' ? scheduler.pathsProblem : null,
          anchorsSource: ANCHOR_SOURCE_IDS.includes(scheduler.anchorsSource)
            ? scheduler.anchorsSource
            : 'default',
          degraded: scheduler.degraded === true,
          lastError: typeof scheduler.lastError === 'string' ? scheduler.lastError : null,
          problem: typeof scheduler.problem === 'string' ? scheduler.problem : null,
          masterPresent: scheduler.masterPresent === true,
        },
        master: master === null
          ? null
          : {
              version: numberOrZero(master.version),
              timezone: typeof master.timezone === 'string' ? master.timezone : '',
              updatedAt: master.updatedAt,
              entries: Array.isArray(master.entries) ? master.entries.filter(isRecord) : [],
            },
        queue: {
          sessionId: typeof queue.sessionId === 'string' ? queue.sessionId : null,
          pending: Array.isArray(queue.pending) ? queue.pending.filter(isRecord) : [],
          delivered: Array.isArray(queue.delivered) ? queue.delivered.filter(isRecord) : [],
        },
        next: isRecord(source.next) ? source.next : null,
      }
    }

    /** `新增 n · 更新 n · 取消 n` sentence of one reconcile result. */
    function queuedSummary(queued, t) {
      return [
        t('plan.count.added') + ' ' + String(numberOrZero(queued.added)),
        t('plan.count.updated') + ' ' + String(numberOrZero(queued.updated)),
        t('plan.count.cancelled') + ' ' + String(numberOrZero(queued.cancelled)),
      ].join(' · ')
    }

    /** Blank draft for the add-entry form. */
    function emptyAddDraft() {
      return { id: '', title: '', action: '', at: '', kind: 'daily', weekday: 'mon' }
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

    /**
     * 顶部 tab 栏：在头部下方切换当前显示的卡片分组，默认「概览」。
     *
     * 采用标准的 tablist 键盘模型：只有选中的按钮在 Tab 顺序里，左右方向键在
     * 分区之间移动焦点并切换，Home/End 跳到首尾。按钮本身沿用 kui-button 的
     * 尺寸与焦点环，选中态用 kui-tab-active 明确区分。
     */
    function TabBar({ t, active, onChange }) {
      const focusAt = (event, index) => {
        const scope = event.currentTarget.parentElement
        if (scope === null || typeof scope.querySelector !== 'function') return
        const button = scope.querySelector('[data-kui-tab="' + TAB_IDS[index] + '"]')
        if (button !== null && typeof button.focus === 'function') button.focus()
      }
      const select = (event, index) => {
        event.preventDefault()
        onChange(TAB_IDS[index])
        focusAt(event, index)
      }
      const move = (event, delta) => {
        const index = TAB_IDS.indexOf(active)
        if (index < 0) return
        select(event, (index + delta + TAB_IDS.length) % TAB_IDS.length)
      }
      return h('div', {
        className: 'kui-tabs',
        role: 'tablist',
        'aria-label': t('tab.label'),
      }, TAB_IDS.map(id => h('button', {
        key: id,
        type: 'button',
        role: 'tab',
        id: TAB_ELEMENT_ID + id,
        'data-kui-tab': id,
        tabIndex: active === id ? 0 : -1,
        'aria-selected': active === id ? 'true' : 'false',
        'aria-controls': TAB_PANEL_ID + id,
        className: active === id ? 'kui-tab kui-tab-active' : 'kui-tab',
        onClick: () => { onChange(id) },
        onKeyDown: event => {
          if (event.key === 'ArrowRight') move(event, 1)
          else if (event.key === 'ArrowLeft') move(event, -1)
          else if (event.key === 'Home') select(event, 0)
          else if (event.key === 'End') select(event, TAB_IDS.length - 1)
        },
      }, t('tab.' + id))))
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
      '.kui-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.kui-tab{height:32px;padding:0 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}',
      '.kui-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.kui-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.kui-tab.kui-tab-active{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.kui-tab.kui-tab-active:hover{background:var(--dsw-alias-bg-module-platform)}',
      '.kui-tabpanel{display:flex;flex-direction:column;gap:16px;min-width:0}',
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
      '.kui-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.kui-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.kui-subcard{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.kui-iso-list{display:flex;flex-direction:column}',
      '.kui-iso-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.kui-iso-row:first-child{border-top:0;padding-top:0}',
      '.kui-iso-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;min-width:0}',
      '.kui-iso-result{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right;word-break:break-word}',
      '.kui-iso-errors{margin:6px 0 0;padding-left:18px;word-break:break-word}',
      '.kui-subtitle{margin:0;font-size:13px;font-weight:600}',
      '.kui-table-wrap{width:100%;overflow-x:auto;overscroll-behavior-x:contain}',
      '.kui-table{width:100%;min-width:620px;border-collapse:collapse;font-size:12px;white-space:nowrap}',
      '.kui-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.kui-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
      '.kui-table tbody tr:last-child td{border-bottom:0}',
      '.kui-time{width:76px;height:28px;padding:0 6px;font-size:12px}',
      '.kui-time-cell{display:flex;flex-direction:column;gap:4px}',
      '.kui-time-text{color:var(--dsw-alias-label-primary)}',
      '.kui-table-actions{display:flex;align-items:center;gap:6px}',
      '.kui-queue{display:flex;flex-direction:column;gap:4px}',
      '.kui-queue-row{display:flex;align-items:baseline;gap:8px;font-size:12px;min-width:0}',
      '.kui-queue-time{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}',
      '.kui-queue-text{min-width:0;word-break:break-word}',
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
     * The plan-schedule card: scheduler health, the editable master table, the
     * add-entry form, and the wake queue.
     *
     * Every write posts one `plan/ops` call carrying the master version this
     * card last read and then renders the returned snapshot, so a second writer
     * surfaces as an explicit 409 instead of a silent overwrite. The routes are
     * served by the optional `kinship-plan-scheduler` plugin: when they are
     * absent (404) or answer non-2xx the card says so and leaves the bridge
     * cards untouched.
     */
    function PlanScheduleCard({ t, plan, planError, onSnapshot, onReload }) {
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [clockDraft, setClockDraft] = useState({})
      const [addDraft, setAddDraft] = useState(emptyAddDraft)
      const [confirmingDelete, setConfirmingDelete] = useState(null)
      const alive = useRef(true)
      const running = useRef(false)
      const noticeTimer = useRef(null)

      useEffect(() => () => {
        alive.current = false
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      }, [])

      const version = plan === null || plan.master === null ? null : plan.master.version
      useEffect(() => {
        setClockDraft({})
        setConfirmingDelete(null)
      }, [version])

      const showNotice = useCallback(next => {
        if (noticeTimer.current !== null) {
          window.clearTimeout(noticeTimer.current)
          noticeTimer.current = null
        }
        setNotice(next)
        if (next !== null && next.kind === 'ok') {
          noticeTimer.current = window.setTimeout(() => {
            if (alive.current) setNotice(null)
          }, 2600)
        }
      }, [])

      const reportFailure = useCallback((error, title) => {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
        if (code === 'master_conflict' || code === 'plan_conflict') {
          showNotice({ kind: 'error', text: t('plan.conflict'), detail: describeError(error) })
          return
        }
        showNotice({ kind: 'error', text: title, detail: describeError(error) })
      }, [showNotice, t])

      const applyAnswer = useCallback(answer => {
        onSnapshot(answer)
        setClockDraft({})
        setConfirmingDelete(null)
      }, [onSnapshot])

      const runOps = useCallback(async (ops, okText) => {
        const master = plan === null ? null : plan.master
        if (master === null || running.current) return false
        running.current = true
        setBusy('ops')
        try {
          const answer = await callJson(ROUTES.planOps, { expectedVersion: master.version, ops })
          if (!alive.current) return false
          applyAnswer(answer)
          showNotice({ kind: 'ok', text: okText })
          return true
        } catch (error) {
          if (!alive.current) return false
          reportFailure(error, t('plan.saveFailed'))
          await onReload()
          return false
        } finally {
          running.current = false
          if (alive.current) setBusy(null)
        }
      }, [plan, applyAnswer, onReload, reportFailure, showNotice, t])

      const clearClockDraft = useCallback(id => {
        setClockDraft(current => {
          if (current[id] === undefined) return current
          const next = { ...current }
          delete next[id]
          return next
        })
      }, [])

      const commitClock = useCallback(async entry => {
        if (!isRecord(entry.schedule)) return
        const current = typeof entry.schedule.at === 'string' ? entry.schedule.at : ''
        const draft = clockDraft[entry.id]
        const text = draft === undefined ? current : String(draft).trim()
        if (text === current || text === '') {
          clearClockDraft(entry.id)
          return
        }
        if (!CLOCK_PATTERN.test(text)) {
          showNotice({ kind: 'error', text: t('plan.invalidTime') })
          clearClockDraft(entry.id)
          return
        }
        await runOps([{ op: 'update_entry', id: entry.id, patch: { schedule: scheduleWithClock(entry.schedule, text) } }], t('plan.updated'))
      }, [clockDraft, clearClockDraft, runOps, showNotice, t])

      const toggleEnabled = useCallback(async entry => {
        await runOps([{ op: 'set_enabled', id: entry.id, enabled: entry.enabled !== true }], t('plan.updated'))
      }, [runOps, t])

      const removeEntry = useCallback(async entry => {
        await runOps([{ op: 'remove_entry', id: entry.id }], t('plan.deleted'))
      }, [runOps, t])

      const seed = useCallback(async () => {
        if (running.current) return
        running.current = true
        setBusy('seed')
        try {
          const answer = await callJson(ROUTES.planSeed, {})
          if (!alive.current) return
          applyAnswer(answer)
          showNotice({ kind: 'ok', text: t('plan.seeded') })
        } catch (error) {
          if (!alive.current) return
          reportFailure(error, t('plan.saveFailed'))
          await onReload()
        } finally {
          running.current = false
          if (alive.current) setBusy(null)
        }
      }, [applyAnswer, onReload, reportFailure, showNotice, t])

      const reconcile = useCallback(async () => {
        if (running.current) return
        running.current = true
        setBusy('reconcile')
        try {
          const answer = await callJson(ROUTES.planReconcile, { reason: 'manual' })
          if (!alive.current) return
          applyAnswer(answer)
          const queued = isRecord(answer) && isRecord(answer.queued) ? answer.queued : {}
          showNotice({ kind: 'ok', text: t('plan.reconciled'), detail: queuedSummary(queued, t) })
        } catch (error) {
          if (!alive.current) return
          reportFailure(error, t('plan.reconcileFailed'))
          await onReload()
        } finally {
          running.current = false
          if (alive.current) setBusy(null)
        }
      }, [applyAnswer, onReload, reportFailure, showNotice, t])

      const updateAdd = useCallback((field, value) => {
        setAddDraft(current => ({ ...current, [field]: value }))
      }, [])

      const submitAdd = useCallback(async () => {
        const id = addDraft.id.trim()
        const title = addDraft.title.trim()
        const action = addDraft.action.trim()
        const at = addDraft.at.trim()
        if (id === '') {
          showNotice({ kind: 'error', text: t('plan.invalidId') })
          return
        }
        if (title === '') {
          showNotice({ kind: 'error', text: t('plan.invalidTitle') })
          return
        }
        if (!CLOCK_PATTERN.test(at)) {
          showNotice({ kind: 'error', text: t('plan.invalidTime') })
          return
        }
        const schedule = addDraft.kind === 'weekly'
          ? { kind: 'weekly', days: [addDraft.weekday], at }
          : { kind: 'daily', at }
        // Backdated one minute: the store stamps `updated_at` from the Host
        // clock, so a browser clock slightly ahead must not violate
        // `updated_at >= created_at`.
        const createdAt = Date.now() - 60_000
        const entry = {
          id,
          kind: 'fixed',
          title,
          enabled: true,
          schedule,
          created_at: createdAt,
          updated_at: Date.now(),
        }
        if (action !== '') entry.action = action
        const saved = await runOps([{ op: 'upsert_entry', entry }], t('plan.added'))
        if (saved) setAddDraft(emptyAddDraft())
      }, [addDraft, runOps, showNotice, t])

      if (planError !== null) {
        const missing = planError.status === 404
        return h(Card, { title: t('plan.title') },
          h('div', { className: 'kui-alert kui-alert-error', role: 'alert' },
            h('div', { style: { fontWeight: 600 } }, missing ? t('plan.missing') : t('plan.loadFailed')),
            missing
              ? null
              : h('div', null, t('plan.missing') + ' · ' + planError.message)))
      }

      if (plan === null) {
        return h(Card, { title: t('plan.title') },
          h('div', { className: 'kui-hint' }, t('plan.loading')))
      }

      const scheduler = plan.scheduler
      const master = plan.master
      const queue = plan.queue
      const modeTone = scheduler.mode === 'live'
        ? 'kui-badge kui-badge-ok'
        : scheduler.mode === 'shadow' ? 'kui-badge kui-badge-warn' : 'kui-badge'
      const modeLabel = scheduler.mode === 'live'
        ? t('plan.mode.live')
        : scheduler.mode === 'shadow' ? t('plan.mode.shadow') : t('plan.mode.off')

      const statusRows = h('div', { className: 'kui-rows' },
        h(Row, { label: t('plan.mode') }, h('span', { className: modeTone }, modeLabel)),
        h(Row, { label: t('plan.planRoot') },
          h('div', null,
            h('div', { className: 'kui-mono' }, scheduler.planRoot === null ? t('plan.planRoot.unset') : scheduler.planRoot),
            h('div', { className: 'kui-hint' }, planRootSourceText(scheduler, t)),
            scheduler.pathsProblem === null
              ? null
              : h('div', { className: 'kui-hint' }, t('plan.source.pushedProblem', { problem: scheduler.pathsProblem })))),
        h(Row, { label: t('plan.stateDir') },
          h('span', { className: 'kui-mono' }, scheduler.stateDir === '' ? '—' : scheduler.stateDir)),
        h(Row, { label: t('plan.timezone') },
          h('div', null,
            h('div', null, scheduler.timezone === '' ? '—' : scheduler.timezone),
            h('div', { className: 'kui-hint' }, timezoneSourceText(plan, t)))),
        h(Row, { label: t('plan.anchors') },
          h('div', null,
            h('div', { className: 'kui-chips' },
              scheduler.anchors.length === 0
                ? h('span', { className: 'kui-hint' }, t('plan.anchors.empty'))
                : scheduler.anchors.map(clock => h('span', { key: clock, className: 'kui-chip' }, clock))),
            h('div', { className: 'kui-hint' }, anchorsSourceText(scheduler, t)))),
        h(Row, { label: t('plan.next') }, h('span', null, nextWakeText(plan, t))))

      const healthTitle = scheduler.degraded ? t('plan.degraded') : t('plan.lastError')
      const healthDetail = scheduler.lastError === null
        ? null
        : scheduler.degraded ? t('plan.lastError') + ' · ' + scheduler.lastError : scheduler.lastError
      const healthNode = scheduler.problem !== null
        ? h('div', { className: 'kui-alert kui-alert-error', role: 'alert' },
          h('div', { style: { fontWeight: 600 } }, t('plan.problem')),
          h('div', null, scheduler.problem))
        : scheduler.degraded || scheduler.lastError !== null
          ? h('div', { className: 'kui-alert kui-alert-error', role: 'status' },
            h('div', { style: { fontWeight: 600 } }, healthTitle),
            healthDetail === null ? null : h('div', null, healthDetail))
          : null

      const noticeNode = notice === null
        ? null
        : h('div', { className: notice.kind === 'ok' ? 'kui-alert kui-alert-ok' : 'kui-alert kui-alert-error', role: 'status' },
          notice.detail === undefined || notice.detail === ''
            ? notice.text
            : h(React.Fragment, null,
              h('div', { style: { fontWeight: 600 } }, notice.text),
              h('div', null, notice.detail)))

      const masterHead = h('div', { className: 'kui-card-head' },
        h('h3', { className: 'kui-subtitle' }, t('plan.master')),
        master === null
          ? null
          : h('span', { className: 'kui-hint' },
            t('plan.master.version') + ' ' + String(master.version) + ' · ' + t('plan.master.updated') + ' ' + formatStamp(master.updatedAt)))

      const tableRows = master === null ? [] : master.entries.map(entry => {
        const draft = clockDraft[entry.id]
        const clock = isRecord(entry.schedule) && typeof entry.schedule.at === 'string' ? entry.schedule.at : ''
        const action = typeof entry.action === 'string' && entry.action !== '' ? entry.action : '—'
        const nextLocal = typeof entry.next_local === 'string' && entry.next_local !== ''
          ? entry.next_local
          : (typeof entry.next_at === 'number' ? formatTime(entry.next_at) : '—')
        return h('tr', { key: entry.id },
          h('td', null,
            h('div', { className: 'kui-time-cell' },
              h('span', { className: 'kui-time-text' }, scheduleText(entry.schedule, t)),
              h('input', {
                className: 'kui-input kui-mono kui-time',
                'aria-label': t('plan.column.time') + ' ' + entry.id,
                value: draft === undefined ? clock : draft,
                disabled: busy !== null,
                onChange: event => {
                  const value = event.target.value
                  setClockDraft(current => ({ ...current, [entry.id]: value }))
                },
                onBlur: () => { void commitClock(entry) },
                onKeyDown: event => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void commitClock(entry)
                },
              }))),
          h('td', null, h('span', { className: 'kui-mono' }, typeof entry.kind === 'string' ? entry.kind : '—')),
          h('td', null, h('span', { className: 'kui-mono' }, action)),
          h('td', null, typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.id),
          h('td', null,
            h('input', {
              className: 'kui-checkbox',
              type: 'checkbox',
              checked: entry.enabled === true,
              disabled: busy !== null,
              'aria-label': t('plan.column.enabled') + ' ' + entry.id,
              onChange: () => { void toggleEnabled(entry) },
            })),
          h('td', null, h('span', { className: 'kui-mono' }, nextLocal)),
          h('td', null, confirmingDelete === entry.id
            ? h('div', { className: 'kui-table-actions' },
              h('button', {
                type: 'button',
                className: 'kui-button kui-button-danger',
                disabled: busy !== null,
                onClick: () => { void removeEntry(entry) },
              }, t('plan.deleteConfirm')),
              h('button', {
                type: 'button',
                className: 'kui-button',
                disabled: busy !== null,
                onClick: () => { setConfirmingDelete(null) },
              }, t('action.cancel')))
            : h('button', {
              type: 'button',
              className: 'kui-button',
              disabled: busy !== null,
              onClick: () => { setConfirmingDelete(entry.id) },
            }, t('plan.delete'))))
      })

      const tableNode = h('div', { className: 'kui-table-wrap' },
        h('table', { className: 'kui-table' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, t('plan.column.time')),
            h('th', { scope: 'col' }, t('plan.column.kind')),
            h('th', { scope: 'col' }, t('plan.column.action')),
            h('th', { scope: 'col' }, t('plan.column.title')),
            h('th', { scope: 'col' }, t('plan.column.enabled')),
            h('th', { scope: 'col' }, t('plan.column.next')),
            h('th', { scope: 'col' }, t('plan.column.actions')))),
          h('tbody', null, tableRows)))

      const addForm = h('div', { className: 'kui-subcard' },
        h('h3', { className: 'kui-subtitle' }, t('plan.add')),
        h('div', { className: 'kui-form' },
          h(Field, { label: t('plan.field.id') },
            h('input', {
              className: 'kui-input kui-mono',
              value: addDraft.id,
              disabled: busy !== null,
              onChange: event => { updateAdd('id', event.target.value) },
            })),
          h(Field, { label: t('plan.field.title') },
            h('input', {
              className: 'kui-input',
              value: addDraft.title,
              disabled: busy !== null,
              onChange: event => { updateAdd('title', event.target.value) },
            })),
          h(Field, { label: t('plan.field.action'), hint: t('plan.field.actionHint') },
            h('input', {
              className: 'kui-input kui-mono',
              value: addDraft.action,
              disabled: busy !== null,
              onChange: event => { updateAdd('action', event.target.value) },
            })),
          h(Field, { label: t('plan.field.at') },
            h('input', {
              className: 'kui-input kui-mono kui-time',
              placeholder: 'HH:MM',
              value: addDraft.at,
              disabled: busy !== null,
              onChange: event => { updateAdd('at', event.target.value) },
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void submitAdd()
              },
            })),
          h(Field, { label: t('plan.field.kind') },
            h('select', {
              className: 'kui-input',
              value: addDraft.kind,
              disabled: busy !== null,
              onChange: event => { updateAdd('kind', event.target.value) },
            },
              h('option', { value: 'daily' }, t('plan.kind.daily')),
              h('option', { value: 'weekly' }, t('plan.kind.weekly')))),
          addDraft.kind === 'weekly'
            ? h(Field, { label: t('plan.field.weekday') },
              h('select', {
                className: 'kui-input',
                value: addDraft.weekday,
                disabled: busy !== null,
                onChange: event => { updateAdd('weekday', event.target.value) },
              },
                WEEKDAY_OPTIONS.map(token => h('option', { key: token, value: token }, weekdayLabel(token, t)))))
            : null),
        h('div', { className: 'kui-actions' },
          h('button', {
            type: 'button',
            className: 'kui-button kui-button-primary',
            disabled: busy !== null,
            onClick: () => { void submitAdd() },
          }, t('plan.addSubmit')),
          h('span', { className: 'kui-hint' }, t('plan.addHint'))))

      const pendingRows = queue.pending.slice(0, 5).map(entry => h('div', { key: 'pending-' + String(entry.id), className: 'kui-queue-row' },
        h('span', { className: 'kui-queue-time' }, formatTime(entry.at)),
        h('span', { className: 'kui-queue-text' },
          (typeof entry.action === 'string' && entry.action !== '' ? entry.action : t('plan.none'))
          + ' · '
          + (typeof entry.title === 'string' && entry.title !== '' ? entry.title : String(entry.id)))))
      const deliveredRows = queue.delivered.slice(-5).map(entry => h('div', { key: 'delivered-' + String(entry.id), className: 'kui-queue-row' },
        h('span', { className: 'kui-queue-time' }, formatTime(entry.delivered_at)),
        h('span', { className: 'kui-queue-text' },
          typeof entry.outcome === 'string' && entry.outcome !== '' ? entry.outcome : t('plan.none'))))

      const queueNode = h('div', { className: 'kui-subcard' },
        h('div', { className: 'kui-card-head' },
          h('h3', { className: 'kui-subtitle' }, t('plan.queue')),
          h('span', { className: 'kui-hint' },
            t('plan.queue.session') + ' · ' + (queue.sessionId === null ? t('plan.none') : queue.sessionId))),
        h('div', { className: 'kui-hint' }, t('plan.queue.pending') + ' ' + String(queue.pending.length)),
        pendingRows.length === 0 ? null : h('div', { className: 'kui-queue' }, pendingRows),
        h('div', { className: 'kui-hint' }, t('plan.queue.delivered') + ' ' + String(queue.delivered.length)),
        deliveredRows.length === 0 ? null : h('div', { className: 'kui-queue' }, deliveredRows),
        queue.pending.length === 0 && queue.delivered.length === 0
          ? h('div', { className: 'kui-hint' }, t('plan.queue.empty'))
          : null)

      const masterSection = h('div', { className: 'kui-subcard' },
        masterHead,
        master === null
          ? h(React.Fragment, null,
            scheduler.masterPresent
              ? h('div', { className: 'kui-hint' }, t('plan.master.unreadable'))
              : h(React.Fragment, null,
                h('div', { className: 'kui-hint' }, t('plan.uninitialized')),
                h('div', { className: 'kui-hint' }, t('plan.uninitializedHint'))),
            h('div', { className: 'kui-actions' },
              h('button', {
                type: 'button',
                className: 'kui-button kui-button-primary',
                disabled: busy !== null,
                onClick: () => { void seed() },
              }, busy === 'seed' ? t('plan.seeding') : t('plan.seed'))))
          : h(React.Fragment, null,
            master.entries.length === 0
              ? h('div', { className: 'kui-hint' }, t('plan.empty'))
              : tableNode,
            addForm))

      const headerAction = h('button', {
        type: 'button',
        className: 'kui-button',
        disabled: busy !== null,
        onClick: () => { void reconcile() },
      }, busy === 'reconcile' ? t('plan.reconciling') : t('plan.reconcile'))

      return h(Card, { title: t('plan.title'), actions: headerAction },
        noticeNode,
        statusRows,
        healthNode,
        masterSection,
        queueNode)
    }

    /**
     * 排异卡片：显示 kinship-isolation 最近一次上报的遮蔽段、工具限制和错误。
     *
     * 数据来自 `/api/kinship/ui/state` 的 `isolation` 字段。旧版 bridge 没有这个
     * 字段（undefined），这里按 null 处理，只显示「未激活」提示，不让面板崩溃。
     */
    function IsolationCard({ t, isolation }) {
      const report = isRecord(isolation) ? isolation : null
      if (report === null) {
        return h(Card, { title: t('isolation.title') },
          h('div', { className: 'kui-hint' }, t('isolation.note')),
          h('div', { className: 'kui-alert', role: 'status' }, t('isolation.missing')))
      }

      const active = report.active === true
      const sections = Array.isArray(report.sections) ? report.sections.filter(isRecord) : []
      const tools = Array.isArray(report.tools) ? report.tools.filter(isRecord) : []
      const errors = Array.isArray(report.errors)
        ? report.errors.filter(message => typeof message === 'string' && message !== '')
        : []
      const preset = typeof report.preset === 'string' && report.preset !== '' ? report.preset : '—'

      const sectionRows = sections.length === 0
        ? [h('div', { key: 'sections-empty', className: 'kui-hint' }, t('isolation.sections.empty'))]
        : sections.map((section, index) => {
          const name = typeof section.name === 'string' && section.name !== '' ? section.name : '—'
          const shadowed = section.shadowed === true
          return h('div', { key: 'section-' + String(index), className: 'kui-iso-row' },
            h('span', { className: 'kui-iso-name' }, name),
            h('span', { className: 'kui-iso-result' },
              h('span', { className: shadowed ? 'kui-badge kui-badge-ok' : 'kui-badge' },
                shadowed ? t('isolation.section.shadowed') : t('isolation.section.unshadowed'))))
        })

      const toolRows = tools.length === 0
        ? [h('div', { key: 'tools-empty', className: 'kui-hint' }, t('isolation.tools.empty'))]
        : tools.map((tool, index) => {
          const prefix = typeof tool.prefix === 'string' && tool.prefix !== '' ? tool.prefix : '—'
          const denied = Array.isArray(tool.denied)
            ? tool.denied.filter(name => typeof name === 'string')
            : []
          const result = denied.length > 0
            ? t('isolation.tools.denied', { count: String(denied.length), names: denied.join(', ') })
            : tool.pending === true ? t('isolation.tools.pending') : t('isolation.tools.none')
          return h('div', { key: 'tool-' + String(index), className: 'kui-iso-row' },
            h('span', { className: 'kui-iso-name' }, prefix),
            h('span', { className: 'kui-iso-result' }, result))
        })

      return h(Card, { title: t('isolation.title') },
        h('div', { className: 'kui-hint' }, t('isolation.note')),
        h('div', { className: 'kui-rows' },
          h(Row, { label: t('isolation.state') },
            h('span', { className: active ? 'kui-badge kui-badge-ok' : 'kui-badge kui-badge-warn' },
              active ? t('isolation.active') : t('isolation.inactive'))),
          h(Row, { label: t('isolation.preset') }, h('span', { className: 'kui-mono' }, preset)),
          h(Row, { label: t('isolation.updated') }, h('span', null, formatTime(report.updatedAt)))),
        h('div', { className: 'kui-subcard' },
          h('h3', { className: 'kui-subtitle' }, t('isolation.sections')),
          h('div', { className: 'kui-iso-list' }, sectionRows)),
        h('div', { className: 'kui-subcard' },
          h('h3', { className: 'kui-subtitle' }, t('isolation.tools')),
          h('div', { className: 'kui-iso-list' }, toolRows)),
        errors.length === 0
          ? null
          : h('div', { className: 'kui-alert kui-alert-error', role: 'alert' },
            h('div', { style: { fontWeight: 600 } }, t('isolation.errors')),
            h('ul', { className: 'kui-iso-errors' },
              errors.map((message, index) => h('li', { key: 'error-' + String(index) }, message)))))
    }

    /**
     * The Kinship page: a tab bar over five fixed card groups — overview
     * (bridge status and Sessions), isolation, plan schedule, access (token and
     * the Kinship-side snippet), and settings.
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
      const [plan, setPlan] = useState(null)
      const [planError, setPlanError] = useState(null)
      /** 当前 tab；只渲染这一组的卡片，默认「概览」。 */
      const [tab, setTab] = useState('overview')
      const alive = useRef(true)

      useEffect(() => () => { alive.current = false }, [])

      const applyPlan = useCallback(answer => {
        setPlan(normalizePlanSnapshot(answer))
        setPlanError(null)
      }, [])

      /**
       * Read the plan snapshot in isolation: when the optional scheduler plugin
       * is absent (404) or fails, only the plan card reports it.
       */
      const loadPlan = useCallback(async () => {
        try {
          const answer = await callJson(ROUTES.plan)
          if (!alive.current) return
          applyPlan(answer)
        } catch (error) {
          if (!alive.current) return
          setPlan(null)
          setPlanError({ status: errorStatus(error), message: describeError(error) })
        }
      }, [applyPlan])

      const load = useCallback(async (quiet) => {
        if (!quiet) setPhase(current => current === 'ready' ? current : 'loading')
        const planTask = loadPlan()
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
        await planTask
      }, [loadPlan])

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

      const allCards = [
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

        h(PlanScheduleCard, {
          key: 'plan',
          t,
          plan,
          planError,
          onSnapshot: applyPlan,
          onReload: loadPlan,
        }),
      ]

      // 固定分组：只把当前 tab 的卡片放进渲染树，其余卡片只是未使用的元素对象。
      // allCards 的顺序固定为：状态、令牌、配置、会话、接入片段、计划。
      const [statusCard, tokenCard, configCard, sessionsCard, snippetCard, planCard] = allCards
      const cardGroups = {
        overview: [statusCard, sessionsCard],
        isolation: [h(IsolationCard, {
          key: 'isolation',
          t,
          // 旧版 bridge 没有 isolation 字段，undefined 与 null 一样按未激活处理。
          isolation: isRecord(snapshot.isolation) ? snapshot.isolation : null,
        })],
        plan: [planCard],
        access: [tokenCard, snippetCard],
        settings: [configCard],
      }
      const cards = cardGroups[tab] === undefined ? cardGroups.overview : cardGroups[tab]

      return h('div', { className: 'kui-page' },
        h('style', null, styles),
        h('div', { className: 'kui-scroll' },
          h('div', { className: 'kui-content' },
            head,
            h(TabBar, { t, active: tab, onChange: setTab }),
            noticeNode,
            h('div', {
              className: 'kui-tabpanel',
              role: 'tabpanel',
              id: TAB_PANEL_ID + tab,
              'aria-labelledby': TAB_ELEMENT_ID + tab,
            }, cards))))
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
