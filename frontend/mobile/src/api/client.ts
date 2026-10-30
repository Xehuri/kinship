/**
 * 核心 API 客户端
 *
 * 提供 apiGet / apiPost 封装，自动注入 Authorization header。
 *
 * 401 触发 onAuthFail 回调的前提: 该请求发出时使用的 token 仍是当前 token。
 * 请求在途期间 token 被轮换/清空时, 过期请求返回的 401 会被忽略,
 * 避免刚注入的新 token 被旧请求误清除。
 *
 * 使用方式:
 *   import { apiGet, apiPost, setToken, onAuthFail } from '@/api/client'
 *   setToken('xxx')
 *   const data = await apiGet<DashboardResponse>('/api/mobile/dashboard?date=2026-06-22')
 *
 * 与原版一致:
 *   - 401 → 仅当请求 token 未过期时触发 auth fail 回调 (LoginOverlay 监听)
 *   - 非 200 → 抛出 Error 后 catch 打印 + 返回 null
 *   - asText=true 强制返回文本, 或 content-type 含 text/ 时自动文本
 *   - 不做任何自动重试 (POST 非幂等)
 */

import { getDeviceId } from '@/composables/useDeviceId';

// ==================== 类型定义 ====================

/** Auth fail 监听函数类型 */
export type AuthFailHandler = () => void;

// ==================== 内部状态 ====================

/** 当前认证 token */
let _token = '';

/** 注册的 auth fail 回调列表 */
const _authFailHandlers: AuthFailHandler[] = [];

// ==================== 设备标识 ====================

/**
 * 设备标识请求头
 *
 * 所有 HTTP 请求统一携带，供后端 DeviceChannelStore 刷新 TTS 回传通道
 * （哪台设备发消息，AI 的 TTS 就回哪台）。device_id 由 useDeviceId 提供，
 * 刷新页面不变；client_type 经 X-Client-Type 告知后端（Web 端固定 web）。
 */
function deviceHeaders(): Record<string, string> {
  return {
    'X-Device-Id': getDeviceId(),
    'X-Client-Type': 'web',
  };
}

// ==================== Token 管理 ====================

/** 获取当前 token */
export function getToken(): string {
  return _token;
}

/** 设置 token (登录成功或初始化时调用) */
export function setToken(token: string): void {
  _token = token;
}

/** 清除 token (登出时调用) */
export function clearToken(): void {
  _token = '';
}

// ==================== Auth fail 事件 ====================

/** 注册 auth fail 监听 (LoginOverlay 通过此函数挂载) */
export function onAuthFail(handler: AuthFailHandler): void {
  if (!_authFailHandlers.includes(handler)) {
    _authFailHandlers.push(handler);
  }
}

/** 移除 auth fail 监听 */
export function offAuthFail(handler: AuthFailHandler): void {
  const idx = _authFailHandlers.indexOf(handler);
  if (idx >= 0) {
    _authFailHandlers.splice(idx, 1);
  }
}

/** 触发所有 auth fail 回调 */
function emitAuthFail(): void {
  for (const handler of _authFailHandlers) {
    try {
      handler();
    } catch (e) {
      console.error('[API] Auth fail handler error:', e);
    }
  }
}

/**
 * 仅在请求发出时的 token 仍是当前 token 时触发 auth fail
 *
 * 并发场景: 旧 token 的请求可能在 token 轮换后才返回 401, 此时新 token
 * 已被外部注入, 不能再因旧请求的 401 清掉它。
 */
function emitAuthFailUnlessStale(requestToken: string): void {
  if (_token !== requestToken) return;
  emitAuthFail();
}

// ==================== 响应解析工具 ====================

/**
 * 将文本响应按调用方约定的泛型 T 返回
 *
 * 文本接口 (asText / content-type=text/*) 的响应体是外部数据, 其真实结构由调用方
 * 通过泛型 T 约定, 静态类型系统无法校验, 因此集中在此做一次受控转换。
 */
function textAs<T>(text: string): T {
  return text as unknown as T;
}

// ==================== 请求方法 ====================

/**
 * GET 请求
 * @param path API 路径 (如 '/api/mobile/dashboard?date=2026-06-22')
 * @param asText 是否强制返回文本 (默认自动判断)
 * @returns 解析后的数据，失败返回 null
 */
export async function apiGet<T = unknown>(
  path: string,
  asText?: boolean,
): Promise<T | null> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = { ...deviceHeaders() };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }

    const r = await fetch(path, { headers });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
      return null;
    }
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    if (asText) {
      return textAs<T>(await r.text());
    }

    const ct = r.headers.get('content-type') || '';
    if (ct.indexOf('text/') >= 0) {
      return textAs<T>(await r.text());
    }

    return (await r.json()) as T;
  } catch (e) {
    console.warn('[API] GET', path, e);
    return null;
  }
}

/**
 * POST 请求
 * @param path API 路径
 * @param body 请求体 (自动 JSON.stringify)
 * @returns 解析后的 JSON，失败返回 null
 */
export async function apiPost<T = unknown>(  path: string,
  body: unknown,
): Promise<T | null> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...deviceHeaders(),
    };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }

    const r = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
      return null;
    }
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    return (await r.json()) as T;
  } catch (e) {
    console.warn('[API] POST', path, e);
    return null;
  }
}

/**
 * DELETE 请求
 * @param path API 路径 (如 '/api/notification/history/3')
 * @returns 解析后的 JSON，失败返回 null
 */
export async function apiDelete<T = unknown>(
  path: string,
): Promise<T | null> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = {
      ...deviceHeaders(),
    };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }

    const r = await fetch(path, {
      method: 'DELETE',
      headers,
    });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
      return null;
    }
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    return (await r.json()) as T;
  } catch (e) {
    console.warn('[API] DELETE', path, e);
    return null;
  }
}

/** apiPostVerbose 返回结构 */
export interface VerboseResponse<T> {
  /** HTTP 状态码 (网络异常时为 0) */
  status: number;
  /** 是否 2xx 成功 */
  ok: boolean;
  /** 解析后的响应体, 无法解析时为 null */
  data: T | null;
}

/**
 * GET 请求 (详细版, FE-M1)
 *
 * 与 apiGet 的区别:
 *   - 不抛出非 2xx 错误, 而是返回 { status, ok, data }
 *   - 调用方可据此区分 401 / 404 / 5xx / 网络错误, 决定是否保留旧数据
 *   - 401 仍触发 auth fail 回调, 但继续返回解析结果
 *
 * @param path API 路径
 * @param asText 是否强制返回文本 (默认自动判断 content-type)
 * @param extraHeaders 额外请求头 (可选, 如配置读取的 X-Config-Password)
 * @returns { status, ok, data } — 网络异常返回 status=0 / ok=false / data=null
 */
export async function apiGetVerbose<T = unknown>(
  path: string,
  asText?: boolean,
  extraHeaders?: Record<string, string>,
): Promise<VerboseResponse<T>> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = { ...deviceHeaders() };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    const r = await fetch(path, { headers });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
    }

    let data: T | null = null;
    try {
      if (asText) {
        data = textAs<T>(await r.text());
      } else {
        const ct = r.headers.get('content-type') || '';
        if (ct.indexOf('text/') >= 0) {
        data = textAs<T>(await r.text());
        } else {
          data = (await r.json()) as T;
        }
      }
    } catch {
      data = null;
    }

    return { status: r.status, ok: r.ok, data };
  } catch (e) {
    console.warn('[API] GET(verbose)', path, e);
    return { status: 0, ok: false, data: null };
  }
}

/**
 * POST 请求 (详细版)
 *
 * 与 apiPost 的区别:
 *   - 不抛出非 2xx 错误, 而是返回 { status, ok, data }
 *   - 即使 4xx/5xx 也尝试解析 JSON 响应体 (便于读取后端错误 message)
 *   - 401 仍触发 auth fail 回调, 但继续返回解析结果
 *
 * @param path API 路径
 * @param body 请求体 (自动 JSON.stringify)
 * @param extraHeaders 额外请求头 (可选, 与内置头合并; 同名时覆盖内置值)
 * @returns { status, ok, data } — 网络异常返回 status=0 / ok=false / data=null
 */
export async function apiPostVerbose<T = unknown>(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<VerboseResponse<T>> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...deviceHeaders(),
    };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    const r = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
    }

    // 即使 4xx/5xx 也尝试解析 JSON; 响应体为空或非 JSON 时 data 为 null
    let data: T | null = null;
    try {
      data = (await r.json()) as T;
    } catch {
      data = null;
    }

    return { status: r.status, ok: r.ok, data };
  } catch (e) {
    console.warn('[API] POST(verbose)', path, e);
    return { status: 0, ok: false, data: null };
  }
}

/**
 * PUT 请求
 *
 * 与 apiPost 语义一致, 仅方法不同 (幂等更新):
 *   - 非 2xx 抛错后 catch 打印并返回 null
 *   - 401 仍按"请求 token 未过期"守卫触发 auth fail
 *
 * @param path API 路径
 * @param body 请求体 (自动 JSON.stringify)
 * @returns 解析后的 JSON，失败返回 null
 */
export async function apiPut<T = unknown>(
  path: string,
  body: unknown,
): Promise<T | null> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...deviceHeaders(),
    };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }

    const r = await fetch(path, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
      return null;
    }
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    return (await r.json()) as T;
  } catch (e) {
    console.warn('[API] PUT', path, e);
    return null;
  }
}

/**
 * PUT 请求 (详细版)
 *
 * 与 apiPostVerbose 语义一致, 仅方法不同:
 *   - 不抛出非 2xx 错误, 返回 { status, ok, data }
 *   - 4xx/5xx 也尝试解析 JSON 响应体 (便于读取后端错误 code/message/errors)
 *   - 401 仍触发 auth fail 回调, 但继续返回解析结果
 *
 * @param path API 路径
 * @param body 请求体 (自动 JSON.stringify)
 * @param extraHeaders 额外请求头 (可选, 与内置头合并; 同名时覆盖内置值)
 * @returns { status, ok, data } — 网络异常返回 status=0 / ok=false / data=null
 */
export async function apiPutVerbose<T = unknown>(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<VerboseResponse<T>> {
  try {
    const requestToken = _token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...deviceHeaders(),
    };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    const r = await fetch(path, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
    }

    let data: T | null = null;
    try {
      data = (await r.json()) as T;
    } catch {
      data = null;
    }

    return { status: r.status, ok: r.ok, data };
  } catch (e) {
    console.warn('[API] PUT(verbose)', path, e);
    return { status: 0, ok: false, data: null };
  }
}

// ==================== 文件上传 ====================

/** 上传文件响应 */
export interface UploadResponse {
  status: string;
  file_name: string;
  file_path: string;
  file_rel_path: string;
  file_size: number;
  user_id: string;
}

/**
 * 上传文件 (multipart/form-data)
 * @param file 要上传的文件
 * @returns 上传结果，失败返回 null
 */
export async function apiUpload(file: File): Promise<UploadResponse | null> {
  try {
    const requestToken = _token;
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = { ...deviceHeaders() };
    if (requestToken) {
      headers['Authorization'] = 'Bearer ' + requestToken;
    }

    const r = await fetch('/api/mobile/upload', {
      method: 'POST',
      headers,
      body: formData,
    });

    if (r.status === 401) {
      emitAuthFailUnlessStale(requestToken);
      return null;
    }
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    return (await r.json()) as UploadResponse;
  } catch (e) {
    console.warn('[API] UPLOAD 失败:', e);
    return null;
  }
}
