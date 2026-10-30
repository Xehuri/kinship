/**
 * API Composable
 *
 * 提供 token 管理、登录/登出、以及所有 API 函数的统一入口。
 *
 * Token 优先级 (与原版一致):
 *   1. URL 参数 ?token=xxx
 *   2. localStorage 'mobile_token'
 *
 * 使用方式:
 *   // 在 App.vue 或 LoginOverlay 中使用:
 *   const { login, logout, isLoggedIn, onAuthFail } = useApi()
 *
 *   // 在任何组件中获取 API 函数:
 *   const { fetchDashboard, fetchHealthQuery } = useApi()
 *   const dash = await fetchDashboard('2026-06-22')
 */

import { ref } from 'vue';
import {
  setToken,
  clearToken,
  getToken,
  onAuthFail as clientOnAuthFail,
  offAuthFail as clientOffAuthFail,
  apiGet,
  apiPost,
  apiPostVerbose,
} from '@/api/client';
import type { AuthFailHandler } from '@/api/client';

// ==================== 登出事件注册 (依赖倒置) ====================
//
// useApi 是认证层, 不得反向依赖功能层 (useRealTime/useChat/useStreamingMessage/useTtsPlayer)。
// 功能模块在初始化时通过 onLogout 订阅登出事件, 自行清理状态;
// logout() 只清 token 并广播事件, 因此认证层无需 import 任何功能 composable。

/** 登出回调 */
export type LogoutHandler = () => void;

/** 已注册的登出回调列表 */
const _logoutHandlers: LogoutHandler[] = [];

/** 注册登出回调 (功能层初始化时调用) */
export function onLogout(handler: LogoutHandler): void {
  if (!_logoutHandlers.includes(handler)) {
    _logoutHandlers.push(handler);
  }
}

/** 移除登出回调 */
export function offLogout(handler: LogoutHandler): void {
  const idx = _logoutHandlers.indexOf(handler);
  if (idx >= 0) {
    _logoutHandlers.splice(idx, 1);
  }
}

/** 触发所有登出回调 (logout() 内部调用) */
function emitLogout(): void {
  for (const handler of _logoutHandlers) {
    try {
      handler();
    } catch (e) {
      console.warn('[useApi] 登出回调执行失败:', e);
    }
  }
}

// 重新导出 API 函数供 composable 用户直接使用
export {
  apiGet,
  apiPost,
  apiPostVerbose,
};

// 重新导出 health API
export {
  fetchDashboard,
  fetchHealthQuery,
} from '@/api/health';

// 重新导出 session API
export {
  listSessions,
  fetchCurrentSessionId,
  getSessionMessages,
  sendMessage,
  createSession,
  switchSession,
} from '@/api/session';

// 重新导出 files API
export {
  fetchDirectory,
  fetchFileContent,
  getFileRawUrl,
} from '@/api/files';

// 重新导出 SSE/WS (非 composable 版本)
export {
  createSSEConnection,
  disconnectSSE,
} from '@/api/sse';
export {
  createWsConnection,
  disconnectWs,
} from '@/api/ws';

// ==================== 登录状态管理 ====================

/** 登录请求体 */
export interface LoginRequest {
  username: string;
  password: string;
}

/** 登录响应 */
export interface LoginResponse {
  success: boolean;
  token: string;
  message?: string;
}

// ==================== 凭据策略 (FE-H1) ====================
//
// 安全整改: 不再把用户名/密码明文写入 localStorage, 仅持久化 token。
// token 失效 (401) 时无法静默重登录, 由 App.vue 弹出登录覆盖层要求用户重新输入。
// 这样即便 XSS 读取了 localStorage, 也无法拿到可复用的长期凭据。

/** 清理本地 token (登出 / 凭据失效时调用) */
function clearLocalToken(): void {
  clearToken();
  try {
    localStorage.removeItem('mobile_token');
  } catch {
    // localStorage 不可用时忽略
  }
}

// ==================== 首次初始化 / 凭据修改 ====================

/**
 * 模块级共享登录状态
 * 与 client.ts 中的 _token 单例保持一致, 保证多个组件调用 useApi() 时状态同步
 */
const isLoggedIn = ref<boolean>(!!getToken());

/** 首次初始化状态响应 */
export interface SetupStatusResponse {
  needs_setup: boolean;
}

/** 修改凭据响应 */
export interface ChangeCredentialsResponse {
  success: boolean;
  token?: string;
  user_id?: string;
  message?: string;
}

/** changeCredentials 归一化返回 */
export interface ChangeCredentialsResult {
  success: boolean;
  token?: string;
  message: string;
}

/** verifyPassword 后端响应体 */
export interface VerifyPasswordResponse {
  valid?: boolean;
  code?: string;
  message?: string;
  retry_after?: number;
}

/** verifyPassword 归一化返回 (不抛出, 保留后端错误 code/message) */
export interface VerifyPasswordResult {
  valid: boolean;
  code?: string;
  message?: string;
  retry_after?: number;
}

/**
 * 查询系统是否需要首次初始化
 * GET /auth/setup-status (公开接口)
 * @returns true 需要初始化 / false 已初始化 / null 请求失败
 */
export async function getSetupStatus(): Promise<boolean | null> {
  const data = await apiGet<SetupStatusResponse>('/auth/setup-status');
  if (data && typeof data.needs_setup === 'boolean') {
    return data.needs_setup;
  }
  return null;
}

/**
 * 首次初始化管理员账号
 * POST /auth/setup (公开接口)
 * 成功后与 login() 一致地仅持久化 token (不保存明文密码)
 *
 * 当后端开启 auth.setup_require_token 时, 需携带一次性引导令牌
 * (Header `X-Setup-Token`, 见 backend/routers/auth_api.py)。
 * setupToken 为空时保持原有的两参数调用, 不附加任何请求头。
 *
 * @param username 管理员用户名
 * @param password 管理员密码
 * @param setupToken 一次性引导令牌 (可选; 仅后端要求时填写)
 * @returns 解析后的响应, 请求失败返回 null
 */
export async function setup(
  username: string,
  password: string,
  setupToken?: string,
): Promise<LoginResponse | null> {
  const token = setupToken?.trim() ?? '';
  const r = token
    ? await apiPostVerbose<LoginResponse>(
        '/auth/setup',
        { username, password },
        { 'X-Setup-Token': token },
      )
    : await apiPostVerbose<LoginResponse>('/auth/setup', {
        username,
        password,
      });
  const data = r.data;

  if (r.ok && data && data.success && data.token) {
    setToken(data.token);
    localStorage.setItem('mobile_token', data.token);
    isLoggedIn.value = true;
  }

  return data;
}

/**
 * 修改用户名/密码
 * POST /auth/change-credentials (需认证)
 *
 * 改密时后端吊销该用户全部旧普通 token 并返回新 token, 这里同步更新以延续当前会话;
 * 仅改名时后端不轮换 token, 响应不含新 token, 既有 token 保持有效。
 * 安全整改后不再缓存任何明文凭据, 仅更新 token。
 */
export async function changeCredentials(
  oldPassword: string,
  newUsername?: string,
  newPassword?: string,
): Promise<ChangeCredentialsResult> {
  const body: Record<string, string> = { old_password: oldPassword };
  if (newUsername) body.new_username = newUsername;
  if (newPassword) body.new_password = newPassword;

  const r = await apiPostVerbose<ChangeCredentialsResponse>(
    '/auth/change-credentials',
    body,
  );
  const data = r.data;

  if (r.ok && data && data.success) {
    if (data.token) {
      setToken(data.token);
      localStorage.setItem('mobile_token', data.token);
    }
  }

  return {
    success: !!(data && data.success),
    token: data?.token,
    message: data?.message || (r.ok ? '操作成功' : 'HTTP ' + r.status),
  };
}

/**
 * 只读校验当前登录用户的密码
 * POST /auth/verify-password (需认证, 仅 user Token)
 *
 * 密码只作为请求体发送, 不写入 localStorage/sessionStorage。
 * 非 2xx 时保留后端 code/message/retry_after, 供调用方区分密码错误与限流。
 */
export async function verifyPassword(
  password: string,
): Promise<VerifyPasswordResult> {
  const r = await apiPostVerbose<VerifyPasswordResponse>(
    '/auth/verify-password',
    { password },
  );
  const data = r.data;

  if (r.ok && data?.valid === true) {
    return { valid: true };
  }

  const result: VerifyPasswordResult = {
    valid: false,
    code:
      data?.code ??
      (r.status === 401
        ? 'auth_required'
        : r.status === 0
          ? 'network_error'
          : 'verify_failed'),
    message:
      data?.message ??
      (r.status === 0 ? '网络异常，请稍后重试' : 'HTTP ' + r.status),
  };
  if (typeof data?.retry_after === 'number') {
    result.retry_after = data.retry_after;
  }
  return result;
}

/** useApi 返回值 */
export interface UseApiReturn {
  /** 当前登录状态 */
  isLoggedIn: import('vue').Ref<boolean>;
  /** 当前 token (getter) */
  token: string;
  /** 登录 (POST /login, 成功后仅保存 token 到 localStorage) */
  login: (username: string, password: string) => Promise<LoginResponse | null>;
  /** 登出 (清除 token + 实时连接 + 聊天/流式/TTS 状态) */
  logout: () => void;
  /** 注册 auth fail 回调 (LoginOverlay 通过此函数打开登录弹窗) */
  onAuthFail: (handler: AuthFailHandler) => void;
  /** 移除 auth fail 回调 */
  offAuthFail: (handler: AuthFailHandler) => void;
  /** 注册 token 刷新回调 (桌面壳 / Android WebView 桥注入新 token 后触发) */
  onTokenRefresh: (handler: TokenRefreshHandler) => void;
  /** 移除 token 刷新回调 */
  offTokenRefresh: (handler: TokenRefreshHandler) => void;
  /** 查询是否需要首次初始化 (GET /auth/setup-status) */
  getSetupStatus: () => Promise<boolean | null>;
  /** 首次初始化管理员账号 (POST /auth/setup, 可选引导令牌) */
  setup: (
    username: string,
    password: string,
    setupToken?: string,
  ) => Promise<LoginResponse | null>;
  /** 修改用户名/密码 (POST /auth/change-credentials) */
  changeCredentials: (
    oldPassword: string,
    newUsername?: string,
    newPassword?: string,
  ) => Promise<ChangeCredentialsResult>;
  /** 只读校验当前密码 (POST /auth/verify-password, 不持久化) */
  verifyPassword: (password: string) => Promise<VerifyPasswordResult>;
}

/**
 * 初始化 token: URL 参数 > localStorage
 * 与原版 index.original.html 的 token 初始化逻辑一致
 *
 * URL token 被消费后立即从地址栏剥离 (保留 device_id/tts_volume/client 与 hash),
 * 否则刷新页面时陈旧 URL token 会覆盖 localStorage 中刚注入的新 token。
 */
function initToken(): void {
  try {
    const url = new URL(window.location.href);
    const urlToken = url.searchParams.get('token');
    const localToken = localStorage.getItem('mobile_token') || '';

    if (urlToken) {
      setToken(urlToken);
      // URL token 存在时也写入 localStorage
      localStorage.setItem('mobile_token', urlToken);
      try {
        url.searchParams.delete('token');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch {
        // 改写地址栏失败时忽略, 已生效的 token 不受影响
      }
    } else if (localToken) {
      setToken(localToken);
    } else {
      setToken('');
    }
  } catch (e) {
    console.warn('[useApi] Token 初始化失败:', e);
    // localStorage 不可用时只从 URL 获取
    try {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      setToken(urlToken || '');
    } catch (e2) {
      setToken('');
    }
  }
}

// ==================== 外部 token 刷新 ====================

/** token 刷新事件载荷 */
export interface TokenRefreshPayload {
  /** 新注入的 token */
  token: string;
  /** 刷新前是否已登录 (供订阅方判断是否需要恢复实时连接) */
  wasLoggedIn: boolean;
}

/** token 刷新回调 */
export type TokenRefreshHandler = (payload: TokenRefreshPayload) => void;

/** 已注册的 token 刷新回调列表 */
const _tokenRefreshHandlers: TokenRefreshHandler[] = [];

/** 注册 token 刷新回调 (功能层初始化时调用) */
export function onTokenRefresh(handler: TokenRefreshHandler): void {
  if (!_tokenRefreshHandlers.includes(handler)) {
    _tokenRefreshHandlers.push(handler);
  }
}

/** 移除 token 刷新回调 */
export function offTokenRefresh(handler: TokenRefreshHandler): void {
  const idx = _tokenRefreshHandlers.indexOf(handler);
  if (idx >= 0) {
    _tokenRefreshHandlers.splice(idx, 1);
  }
}

/** 触发所有 token 刷新回调 */
function emitTokenRefresh(payload: TokenRefreshPayload): void {
  for (const handler of _tokenRefreshHandlers) {
    try {
      handler(payload);
    } catch (e) {
      console.warn('[useApi] token 刷新回调执行失败:', e);
    }
  }
}

/** 事件 detail 解析后的统一形态 */
interface TokenRefreshDetail {
  token: string;
  wasLoggedIn?: boolean;
}

/**
 * 解析 token 刷新事件 detail
 *
 * 兼容两种契约:
 *   - 字符串: 旧桌面壳经 executeJavaScript 派发的裸 token
 *   - 对象: { token, wasLoggedIn? }, 由桌面壳或 Android WebView 桥派发
 */
function parseTokenRefreshDetail(detail: unknown): TokenRefreshDetail | null {
  if (typeof detail === 'string') {
    return detail.length > 0 ? { token: detail } : null;
  }
  if (typeof detail === 'object' && detail !== null) {
    const raw = detail as Record<string, unknown>;
    if (typeof raw.token === 'string' && raw.token.length > 0) {
      return {
        token: raw.token,
        wasLoggedIn:
          typeof raw.wasLoggedIn === 'boolean' ? raw.wasLoggedIn : undefined,
      };
    }
  }
  return null;
}

/** 外部 token 刷新 CustomEvent 名 (桌面壳与 Android WebView 桥均会派发) */
const TOKEN_REFRESH_EVENT = 'axeuh-token-refresh';

/** 监听器是否已安装 (保证只安装一次) */
let _tokenRefreshListenerInstalled = false;

/**
 * 安装外部 token 刷新监听 (页面生命周期内常驻, 不随组件卸载移除)
 *
 * 桌面壳与 Android WebView 桥通过 CustomEvent('axeuh-token-refresh') 注入新 token,
 * 让 SPA 在不刷新页面的情况下切换后端 token。
 */
function installTokenRefreshListener(): void {
  if (_tokenRefreshListenerInstalled) return;
  _tokenRefreshListenerInstalled = true;

  window.addEventListener(TOKEN_REFRESH_EVENT, (event: Event) => {
    const parsed = parseTokenRefreshDetail((event as CustomEvent<unknown>).detail);
    if (!parsed) return;

    // 必须在写入新 token 前快照登录态, 否则订阅方无法判断刷新前是否已登录
    const wasLoggedIn =
      parsed.wasLoggedIn ?? (isLoggedIn.value || getToken().length > 0);

    setToken(parsed.token);
    try {
      localStorage.setItem('mobile_token', parsed.token);
    } catch {
      // localStorage 不可用时忽略
    }
    isLoggedIn.value = true;

    emitTokenRefresh({ token: parsed.token, wasLoggedIn });
  });
}

/**
 * API Composable — 主入口
 *
 * 每个组件都可独立调用 useApi(), 它们共享同一个底层 token
 * (因为 client.ts 中的 _token 是模块级单例)
 */
export function useApi(): UseApiReturn {
  // 登录状态使用模块级单例 (见文件上方 isLoggedIn 声明)

  // 桌面端 token 刷新监听 (模块级, 仅安装一次)
  installTokenRefreshListener();

  // 初始化 token (仅首次)
  if (!getToken()) {
    initToken();
    isLoggedIn.value = !!getToken();
  }

  /**
   * 登录
   * POST /login { username, password }
   * 成功后仅保存 token 到 client 和 localStorage (不持久化明文密码)
   */
  async function login(
    username: string,
    password: string,
  ): Promise<LoginResponse | null> {
    try {
      const r = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password } satisfies LoginRequest),
      });
      const data: LoginResponse = await r.json();

      if (data.success && data.token) {
        setToken(data.token);
        localStorage.setItem('mobile_token', data.token);
        isLoggedIn.value = true;
      }

      return data;
    } catch (e) {
      console.error('[useApi] 登录失败:', e);
      return null;
    }
  }

  /**
   * 登出 (FE-H6)
   *
   * 清除 token 与登录状态后, 通过 emitLogout 广播登出事件;
   * 功能层 (实时连接/聊天/流式/TTS) 通过 onLogout 订阅并自行清理,
   * 认证层不直接依赖任何功能 composable。
   */
  function logout(): void {
    clearLocalToken();
    isLoggedIn.value = false;

    // 广播登出事件, 由各功能模块注册的回调完成: 断开 SSE/WS、清空聊天/流式状态、停止 TTS
    emitLogout();
  }

  return {
    isLoggedIn,
    get token(): string {
      return getToken();
    },
    login,
    logout,
    onAuthFail: clientOnAuthFail,
    offAuthFail: clientOffAuthFail,
    onTokenRefresh,
    offTokenRefresh,
    getSetupStatus,
    setup,
    changeCredentials,
    verifyPassword,
  };
}
