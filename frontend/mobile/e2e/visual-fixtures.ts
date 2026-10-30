import { test as base, expect } from './fixtures'

/**
 * 已认证视觉截图夹具。
 *
 * 在 e2e/fixtures.ts 的无后端基线上叠加:
 * - 注入 mobile_token 与 theme, 页面启动即视为已登录;
 * - 为 auth/setup-status, auth/ws-ticket 提供稳定响应;
 * - 为报告/提醒/通知端点返回固定样例数据, 保证截图可重复;
 * - 其余 /api/** 继续由基线夹具返回 200 {}。
 *
 * 主题通过 visualTheme 选项传给测试, 由 addInitScript 写入 localStorage,
 * 应用 useTheme 初始化时会读取并设置 data-theme。
 */

export type VisualTheme = 'light' | 'dark'

export interface VisualFixtures {
  visualTheme: VisualTheme
}

/** 固定报告样例: 覆盖多种 kind 与标签, 避免截图内容为空。 */
const REPORTS = [
  {
    title: '10月22日行为日报',
    date: '2026-10-22',
    type: 'daily',
    kind: 'daily',
    tags: ['日常', '行为'],
    path: 'reports/2026-10-22-daily.md',
    size_bytes: 48123,
  },
  {
    title: '第42周健康复盘',
    date: '2026-10-20',
    type: 'weekly',
    kind: 'weekly',
    tags: ['健康', '复盘'],
    path: 'reports/2026-10-20-weekly.md',
    size_bytes: 96340,
  },
  {
    title: '十月上旬行为模式分析',
    date: '2026-10-15',
    type: 'monthly',
    kind: 'monthly',
    tags: ['行为', '分析'],
    path: 'reports/2026-10-15-monthly.md',
    size_bytes: 152870,
  },
  {
    title: '睡眠质量专项审计',
    date: '2026-10-12',
    type: 'audit',
    kind: 'audit',
    tags: ['健康', '睡眠'],
    path: 'reports/2026-10-12-audit.md',
    size_bytes: 22716,
  },
  {
    title: '社交活动记录',
    date: '2026-10-08',
    type: 'other',
    kind: 'other',
    tags: ['社交'],
    path: 'reports/2026-10-08-social.md',
    size_bytes: 8192,
  },
]

/** 固定提醒文本 (多行, 覆盖行标记布局)。 */
const REMINDERS = ['今天 21:30 前完成英语语法练习', '明早出门带伞', '睡前把手机放到书桌'].join('\n')

/** 固定 updated_at (Unix 秒), 让时间文案可重复。 */
const REMINDERS_UPDATED_AT = 1792838400

/** 健康摘要数据 (报告页顶部条 / 设置页健康卡片共用)。 */
const DASHBOARD = {
  date: '2026-10-24',
  health: {
    heart_rate: { avg: 72 },
    steps: 8421,
    sleep: { duration_min: 452 },
    spo2: { avg: 97 },
    stress: { avg: 32 },
  },
  perception: {
    gps_records: 1071,
    battery_timeline: [
      { t: 1, level: 90 },
      { t: 2, level: 82 },
    ],
  },
}

/** 文件根目录样例 (mtime 由 API 层归一化为 modified_at)。 */
const FILES = {
  entries: [
    { name: 'daily', type: 'dir', size: 0, mtime: '2026-10-24T18:00:00' },
    { name: 'reports', type: 'dir', size: 0, mtime: '2026-10-24T17:00:00' },
    { name: 'README.md', type: 'md', size: 8192, mtime: '2026-10-24T16:00:00' },
    { name: 'perception.jsonl', type: 'jsonl', size: 95312, mtime: '2026-10-24T18:01:00' },
    { name: 'health.json', type: 'json', size: 20480, mtime: '2026-10-24T18:02:00' },
  ],
}

/** 数据源健康样例: 覆盖 ok/stale/offline/unknown 四种状态。 */
const SOURCES = {
  generated_at: '2026-10-24T18:05:00+08:00',
  sources: [
    {
      id: 'phone_health',
      name: '手机健康数据',
      status: 'stale',
      last_sync: '2026-09-23T00:19:40+08:00',
      records: 763,
      detail: '分片 2026-09-22 最后写入已超过 6 小时',
    },
    {
      id: 'mi_cloud',
      name: '小米健康云',
      status: 'ok',
      last_sync: '2026-10-24T18:01:00+08:00',
      records: 1079,
      detail: '最近一次同步成功',
    },
    {
      id: 'pc_sensor',
      name: 'PC 感知采集',
      status: 'ok',
      last_sync: '2026-10-24T18:02:00+08:00',
      records: 7,
      detail: '分片 2026-10-24 最近 10 分钟内有 PC 上报',
    },
    {
      id: 'realtime',
      name: '实时事件流',
      status: 'offline',
      last_sync: null,
      records: null,
      detail: '当前无 SSE 订阅连接',
    },
    {
      id: 'loom',
      name: 'Loom AI 后端',
      status: 'unknown',
      last_sync: null,
      records: null,
      detail: '尚未完成 Loom 健康探测',
    },
    {
      id: 'files',
      name: '每日感知文件',
      status: 'ok',
      last_sync: '2026-10-24T18:02:00+08:00',
      records: 3939,
      detail: '今日分片最近 10 分钟内有写入',
    },
  ],
}

/** Web 通道后端状态。 */
const WEB_BACKEND = { backend: 'loom', options: ['opencode', 'loom'] }

/** 小米健康云状态, 让设置页健康卡片显示正常态。 */
const CLOUD_STATUS = {
  enabled: true,
  configured: true,
  phase: 'ok',
  userid: '84210001',
  region: 'cn',
  poll_interval_min: 30,
  overlap_days: 1,
  last_attempt: 1792838400,
  last_success: 1792838400,
  watermark: 1792831200,
  last_error: '',
  last_batches: 1,
  consecutive_failures: 0,
  latest_cloud_shard: '2026-10-24',
}

/** PC 采集端文件信息, 让设置页设备区显示已构建大小。 */
const PC_SENSOR_INFO = {
  exists: true,
  filename: 'Kinship-PCSensor.exe',
  size: 35553280,
  size_text: '33.9 MB',
  mtime: 1792838400,
  sha256: 'a'.repeat(64),
}

/** 会话列表: 一条 Loom 当前会话与一条 OpenCode 历史会话。 */
const CHAT_SESSIONS = {
  local_sessions: [
    {
      session_id: 'ses_loom_demo',
      title: '知己',
      date: '2026-10-24T10:01:00+08:00',
      active: true,
    },
  ],
  opencode_sessions: [],
  current_session: 'ses_loom_demo',
  sessions: [
    {
      session_id: 'ses_loom_demo',
      title: '知己',
      date: '2026-10-24T10:01:00+08:00',
      updated: 1792807260000,
      backend: 'loom',
    },
    {
      session_id: 'ses_opencode_demo',
      title: '代码复盘',
      date: '2026-10-23T21:10:00+08:00',
      updated: 1792761000000,
      backend: 'opencode',
    },
  ],
  loom_sessions: [],
  partial: [],
}

/** 会话历史: 压缩分隔线 + 一轮完整的用户/助手对话 (思考与已完成的 tool)。 */
const CHAT_HISTORY = {
  session_id: 'ses_loom_demo',
  count: 3,
  next_cursor: null,
  messages: [
    {
      info: {
        id: 'msg_compaction_loom_demo_42',
        role: 'assistant',
        sessionID: 'ses_loom_demo',
        mode: 'compaction',
        summary: true,
        time: { created: 1792805400000 },
      },
      parts: [
        {
          type: 'compaction',
          id: 'prt_compaction_1',
          summaryText: '已压缩 42 条历史消息，保留最近对话与未完成任务。',
        },
      ],
    },
    {
      info: {
        id: 'msg_user_1',
        role: 'user',
        sessionID: 'ses_loom_demo',
        time: { created: 1792807200000 },
      },
      parts: [
        {
          type: 'text',
          id: 'prt_user_text_1',
          text: '帮我看下今天的健康数据，有没有异常？',
        },
      ],
    },
    {
      info: {
        id: 'msg_assistant_1',
        role: 'assistant',
        sessionID: 'ses_loom_demo',
        time: { created: 1792807230000, completed: 1792807260000 },
        tokens: {
          total: 18432,
          input: 15200,
          output: 3232,
          reasoning: 480,
        },
      },
      parts: [
        {
          type: 'reasoning',
          id: 'prt_reasoning_1',
          time: { start: 1792807230000, end: 1792807238000 },
          text: '先读取今天的健康分片，核对心率、步数和睡眠，再判断是否有异常。',
        },
        {
          type: 'tool',
          id: 'prt_tool_read_1',
          callID: 'call_read_health_1',
          tool: 'read',
          time: { start: 1792807238000, end: 1792807245000 },
          state: {
            status: 'completed',
            input: { filePath: 'ai/data/daily/2026-10-24/health.json' },
            output:
              '{"date":"2026-10-24","heart_rate":{"avg":72},"steps":8421,"sleep":{"duration_min":452},"spo2":{"avg":97}}',
          },
        },
        {
          type: 'text',
          id: 'prt_assistant_text_1',
          text: '今天整体平稳：平均心率 72 bpm，步数 8,421，睡眠 7 小时 32 分，血氧 97%。没有明显异常，只有取药提醒还没有回执，晚上记得确认一下。',
        },
      ],
    },
  ],
}


/** 本地日期 YYYY-MM-DD, 与 usePlan 的初始日期一致。 */
function localDateInput(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地当天的某个时刻 (返回 ISO 字符串, 页面按本地时区展示)。 */
function localIsoAt(hour: number, minute = 0): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString()
}

/** 本地当天的某个时刻 (Unix 秒)。 */
function localUnixAt(hour: number, minute = 0): number {
  const now = new Date()
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).getTime() / 1000)
}

const PLAN_DATE = localDateInput()

/** 固定计划样例: 7 个 coverage 检查点、两条计划条目、告警与备注。 */
const PLAN = {
  schema: 1,
  date: PLAN_DATE,
  status: 'committed',
  version: 3,
  created_at: localUnixAt(5),
  updated_at: localUnixAt(6),
  review_at: localUnixAt(7, 30),
  items: [
    {
      id: 'c1',
      kind: 'care',
      intent: '上午把材料提交掉',
      status: 'planned',
      target_date: PLAN_DATE,
      window: '09:30~11:00',
      checkpoint_id: 'cov-08',
      done_when: '材料提交成功',
      not_do: '不主动提理发',
      source: 'data_check',
      note: '缺一张照片',
    },
    {
      id: 'c2',
      kind: 'coverage',
      intent: '补看昨天夜里的音频',
      status: 'done',
      window: '22:00~00:00',
      checkpoint_id: 'cov-00',
      done_when: 'check_coverage exit 0',
    },
  ],
  coverage: {
    profile: 'merged_7',
    checkpoints: [
      'cov-00',
      'cov-06',
      'cov-08',
      'cov-12',
      'cov-16',
      'cov-20',
      'cov-22',
    ],
    debt: ['cov-16 未收口'],
  },
  notes: ['周五拍照要理发，先别催'],
}

/** 长期任务样例: 一条今天到期, 一条未来 (计划页只展示到期项)。 */
const PLAN_LONG_TASKS = {
  tasks: [
    {
      schema: 1,
      id: 'lt_weekly_review',
      title: '每周复盘',
      intent: '把一周的事收口',
      cadence: 'weekly',
      next_check: localIsoAt(20),
      last_done: null,
      status: 'active',
      review_policy: 'after_done',
      notes: ['周日晚上做'],
      created_at: localUnixAt(5),
      updated_at: localUnixAt(6),
      version: 3,
    },
    {
      schema: 1,
      id: 'lt_future_checkup',
      title: '下个月复诊',
      intent: '提前确认复诊安排',
      cadence: 'once',
      next_check: new Date(new Date().getTime() + 19 * 24 * 3600 * 1000).toISOString(),
      last_done: null,
      status: 'active',
      review_policy: 'none',
      notes: [],
      created_at: localUnixAt(5),
      updated_at: localUnixAt(6),
      version: 1,
    },
  ],
  generated_at: localUnixAt(6),
}

const PLAN_WARNINGS = ['昨日 22:00-00:00 的音频缺 2 个分片']

export const test = base.extend<VisualFixtures>({
  visualTheme: ['dark', { option: true }],

  page: async ({ page, visualTheme }, use) => {
    await page.addInitScript(
      ({ token, theme }) => {
        try {
          localStorage.setItem('mobile_token', token)
          localStorage.setItem('theme', theme)
          localStorage.setItem('mobile_mock_data', 'false')
        } catch {
          // localStorage 不可用时忽略: 夹具只服务于正常浏览器上下文
        }
      },
      { token: 'visual-qa-token', theme: visualTheme },
    )

    await page.route('**/auth/setup-status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needs_setup: false }),
      }),
    )

    await page.route('**/auth/ws-ticket', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ticket: 'visual-qa-ticket', expires_in: 30 }),
      }),
    )

    await page.route(
      (url) => url.pathname === '/api/mobile/reports',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ reports: REPORTS }),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/reminders',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ text: REMINDERS, updated_at: REMINDERS_UPDATED_AT }),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/notification/history',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ notifications: [], total: 0 }),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/mobile/dashboard',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(DASHBOARD),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/mobile/files',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(FILES),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/sources/health',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(SOURCES),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/screen/backend',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(WEB_BACKEND),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/health/cloud/status',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(CLOUD_STATUS),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/pc-sensor/info',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PC_SENSOR_INFO),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/screen/session/list',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(CHAT_SESSIONS),
        }),
    )

    await page.route(
      (url) =>
        url.pathname.startsWith('/api/screen/session/') && url.pathname.endsWith('/messages'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(CHAT_HISTORY),
        }),
    )

    await page.route(
      (url) => url.pathname === '/api/plan/long-tasks',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PLAN_LONG_TASKS),
        }),
    )

    await page.route(
      (url) => /^\/api\/plan\/\d{4}-\d{2}-\d{2}$/.test(url.pathname),
      (route) => {
        const requested = new URL(route.request().url()).pathname.split('/').pop() ?? PLAN_DATE
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            date: requested,
            plan: { ...PLAN, date: requested },
            coverage: PLAN.coverage,
            long_tasks_due: [],
            warnings: PLAN_WARNINGS,
            generated_at: localUnixAt(6),
          }),
        })
      },
    )

    await use(page)
  },
})

export { expect }
