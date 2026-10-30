/**
 * 设备标识 Composable
 *
 * 为当前浏览器/WebView 提供稳定且持久的 device_id，用于 TTS 设备路由
 * （后端据此判断"最近发消息的设备"）。
 *
 * 取值优先级：
 *   1. URL 查询参数 `device_id`（Android App 加载 WebView 时注入，与原生入口共享同一 id）
 *   2. localStorage['axeuh_device_id']（刷新页面不变）
 *   3. 新生成 `web-<uuid>` 并写入 localStorage
 *
 * 无痕模式/localStorage 不可用时：每次会话生成临时 id（隔离是预期行为）。
 */

const STORAGE_KEY = 'axeuh_device_id';

/** 模块级缓存：保证同一页面生命周期内多次调用返回同一个值 */
let _deviceId = '';

/** 生成一个随机标识（优先 crypto.randomUUID，降级为时间戳 + 随机串） */
function generateDeviceId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return 'web-' + c.randomUUID();
  }
  return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** 读取 URL 查询参数中的 device_id（App 注入） */
function readDeviceIdFromUrl(): string {
  try {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('device_id') || '';
  } catch {
    return '';
  }
}

/** 安全读 localStorage */
function readStoredDeviceId(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/** 安全写 localStorage */
function storeDeviceId(id: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage 不可用（无痕等），忽略
  }
}

/**
 * 获取当前设备标识（稳定、持久、无痕隔离）
 *
 * 非组件环境（如 api/ws.ts）直接调用即可。
 */
export function getDeviceId(): string {
  if (_deviceId) return _deviceId;

  const fromUrl = readDeviceIdFromUrl();
  if (fromUrl) {
    _deviceId = fromUrl;
    storeDeviceId(fromUrl);
    return _deviceId;
  }

  const stored = readStoredDeviceId();
  if (stored) {
    _deviceId = stored;
    return _deviceId;
  }

  _deviceId = generateDeviceId();
  storeDeviceId(_deviceId);
  return _deviceId;
}

/** 组合式函数入口：组件内使用 `const { deviceId } = useDeviceId()` */
export function useDeviceId(): { deviceId: string } {
  return { deviceId: getDeviceId() };
}
