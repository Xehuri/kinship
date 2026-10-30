<template>
  <div
    v-if="visible"
    ref="overlayRef"
    class="gps-overlay"
    data-testid="gps-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="GPS 移动轨迹"
    tabindex="-1"
    @click.self="close"
  >
    <div class="gps-overlay-content">
      <!-- 头部 -->
      <div class="gps-overlay-header">
        <span class="gps-overlay-title">GPS 移动轨迹</span>
        <button class="gps-overlay-close" type="button" aria-label="关闭地图" @click="close">
          <AppIcon name="X" :size="18" />
        </button>
      </div>

      <!-- 地图容器 -->
      <div ref="mapWrapRef" class="gps-map-wrap">
        <div v-if="mapLoading" class="gps-map-loading">
          <div class="gps-map-spinner"></div>
          <span>地图加载中...</span>
        </div>
        <!-- 点信息面板 (浮在地图上方) -->
        <div class="gps-point-info">
          <div class="pi-header">
            <span class="pi-index">{{ selectedIndex >= 0 ? `${selectedIndex + 1} / ${gpsPoints.length}` : '' }}</span>
            <span class="pi-time">
              {{ selectedPoint ? formatTimeRange(selectedPoint) : '点击地图上的点查看详情' }}
              <span v-if="selectedPoint && (selectedPoint.count ?? 1) > 1" class="pi-count">
                {{ selectedPoint.count }} 条记录
              </span>
            </span>
          </div>
          <div class="pi-coord">
            {{ selectedPoint ? `${selectedPoint.lat.toFixed(5)}, ${selectedPoint.lng.toFixed(5)}` : '' }}
          </div>
          <div v-if="selectedPoint?.place" class="pi-place">
            <AppIcon name="MapPin" :size="14" />
            {{ selectedPoint.place }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * GPS 全屏地图覆盖层组件
 *
 * 使用百度地图 (BMap) 展示 GPS 轨迹的全屏地图
 * - 暗色主题
 * - 轨迹线 + 标记点
 * - WGS84 转 BD09 坐标
 * - 点击标记显示详情
 * - 动态加载百度地图 API (仅在 visible 时)
 * - 组件销毁时清理地图实例
 */

import { ref, watch, onUnmounted, nextTick } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useFocusTrap } from '@/composables/useFocusTrap';
import type { MergedGpsPoint } from '@/types/gps';

// ==================== 百度地图类型声明 ====================

declare global {
  interface Window {
    BMap: BMapNamespace;
  }
}

interface BMapPointObj {
  lat: number;
  lng: number;
}

interface BMapSizeObj {
  width: number;
  height: number;
}

interface BMapBoundsInst {
  extend(point: BMapPointObj): void;
  getNorthEast(): BMapPointObj;
  getSouthWest(): BMapPointObj;
}

/** 百度地图 Icon 实例 (仅用于追踪) */
interface BMapIconInst {
  _url: string;
}

/** 百度地图 Polyline 实例 (仅用于追踪) */
interface BMapPolylineInst {
  _points: BMapPointObj[];
}

/** 百度地图 Marker 实例 */
interface BMapMarkerInst {
  addEventListener(event: string, handler: () => void): void;
  removeEventListener(event: string, handler: () => void): void;
}

/** 百度地图 Map 实例 */
interface BMapMapInst {
  centerAndZoom(point: BMapPointObj, zoom: number): void;
  addOverlay(overlay: BMapPolylineInst | BMapMarkerInst): void;
  removeOverlay(overlay: BMapPolylineInst | BMapMarkerInst): void;
  setViewport(view: BMapPointObj[] | BMapBoundsInst, opts?: Record<string, unknown>): void;
  setMapStyle(opts: Record<string, unknown>): void;
  reset(): void;
  addEventListener(event: string, handler: () => void): void;
  removeEventListener(event: string, handler: () => void): void;
  destroy(): void;
}

/** 百度地图命名空间构造签名 */
interface BMapNamespace {
  Map: new (container: HTMLElement | string, opts?: Record<string, unknown>) => BMapMapInst;
  Point: new (lng: number, lat: number) => BMapPointObj;
  Size: new (w: number, h: number) => BMapSizeObj;
  Bounds: new () => BMapBoundsInst;
  Icon: new (url: string, size: BMapSizeObj, opts?: Record<string, unknown>) => BMapIconInst;
  Polyline: new (points: BMapPointObj[], opts?: Record<string, unknown>) => BMapPolylineInst;
  Marker: new (point: BMapPointObj, opts?: Record<string, unknown>) => BMapMarkerInst;
}

// ==================== 坐标转换 (WGS84 -> GCJ02 -> BD09) ====================

const x_PI = 3.14159265358979324 * 3000.0 / 180.0;
const pi = 3.1415926535897932384626;
const aCoeff = 6378245.0;
const ee = 0.00669342162296594323;

function isOutOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * pi) + 40.0 * Math.sin(y / 3.0 * pi)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * pi) + 320.0 * Math.sin(y * pi / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * pi) + 40.0 * Math.sin(x / 3.0 * pi)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * pi) + 300.0 * Math.sin(x / 30.0 * pi)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lat: number, lng: number): BMapPointObj {
  if (isOutOfChina(lat, lng)) {
    return { lat, lng };
  }
  let dlat = transformLat(lng - 105.0, lat - 35.0);
  let dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = lat / 180.0 * pi;
  let magic = Math.sin(radlat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dlat = (dlat * 180.0) / ((aCoeff * (1 - ee)) / (magic * sqrtMagic) * pi);
  dlng = (dlng * 180.0) / (aCoeff / sqrtMagic * Math.cos(radlat) * pi);
  return {
    lat: lat + dlat,
    lng: lng + dlng,
  };
}

function gcj02ToBd09(lat: number, lng: number): BMapPointObj {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * x_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * x_PI);
  return {
    lng: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006,
  };
}

function wgs84ToBd09(lat: number, lng: number): BMapPointObj {
  const gcj02 = wgs84ToGcj02(lat, lng);
  return gcj02ToBd09(gcj02.lat, gcj02.lng);
}

// ==================== Props & Emits ====================

const props = defineProps<{
  /** 是否可见 */
  visible: boolean;
  /** GPS 点数据 */
  gpsPoints: MergedGpsPoint[];
}>();

const emit = defineEmits<{
  /** 关闭覆盖层 */
  close: [];
}>();

// ==================== Refs ====================

const overlayRef = ref<HTMLDivElement | null>(null);
const mapWrapRef = ref<HTMLDivElement | null>(null);
const mapLoading = ref(true);
const selectedIndex = ref(-1);
const selectedPoint = ref<MergedGpsPoint | null>(null);

/** 键盘可达: Escape 关闭, Tab 限制在覆盖层内 */
const focusTrap = useFocusTrap(overlayRef, {
  onEscape: () => close(),
});

// ==================== 定时器管理 (FE-M7) ====================

/** 组件内所有延迟定时器句柄 (卸载/关闭时统一清理, 防止回调操作已销毁的地图) */
const _timers = new Set<ReturnType<typeof setTimeout>>();

/** 创建一个受管理的定时器 (执行后自动从集合移除) */
function setManagedTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    _timers.delete(t);
    fn();
  }, ms);
  _timers.add(t);
  return t;
}

/** 清理全部受管理定时器 */
function clearManagedTimers(): void {
  _timers.forEach((t) => clearTimeout(t));
  _timers.clear();
}

// ==================== 页面滚动锁 ====================

/** v2 壳层的实际滚动容器; 只锁 body/html 无法阻止其滚动 */
let lockedShellBody: HTMLElement | null = null;
let previousShellBodyOverflow = '';

function lockShellBody(): void {
  if (lockedShellBody) return;
  lockedShellBody = document.querySelector<HTMLElement>('.ax-shell__body');
  if (!lockedShellBody) return;
  previousShellBodyOverflow = lockedShellBody.style.overflow;
  lockedShellBody.style.overflow = 'hidden';
}

function unlockShellBody(): void {
  if (!lockedShellBody) return;
  lockedShellBody.style.overflow = previousShellBodyOverflow;
  lockedShellBody = null;
  previousShellBodyOverflow = '';
}

// ==================== 地图状态 ====================

let bmap: BMapMapInst | null = null;

/**
 * 标记点及其点击处理器。
 * 保存 handler 引用是为了在清理时调用 removeEventListener (FE-L2),
 * 避免地图重建/卸载后旧监听残留导致泄漏或重复触发。
 */
interface MarkerEntry {
  marker: BMapMarkerInst;
  handler: () => void;
}
let markers: MarkerEntry[] = [];
let routeLine: BMapPolylineInst | null = null;
let mapClickHandler: (() => void) | null = null;

// ==================== 工具函数 ====================

/** 格式化时间范围 */
function formatTimeRange(p: MergedGpsPoint): string {
  if (!p.t) return '';
  const start = p.timeStart || p.t;
  const end = p.timeEnd || p.t;
  if (start === end) return start;
  return start + ' ~ ' + end;
}

/** 关闭覆盖层 */
function close(): void {
  emit('close');
}

/** 获取 BMap 命名空间 (需确保已加载) */
function getBMap(): BMapNamespace {
  return window.BMap;
}

/** 创建 SVG 圆形图标的数据 URI */
function createMarkerIconUri(size: number, color: string): string {
  const r = (size - 3) / 2;
  const half = size / 2;
  const svgParts: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="', String(size), '" height="', String(size),
    '" viewBox="0 0 ', String(size), ' ', String(size), '">',
    '<circle cx="', String(half), '" cy="', String(half), '" r="', String(r),
    '" fill="', color, '" stroke="#ffffff" stroke-width="1.5"/>',
    '</svg>',
  ];
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgParts.join(''));
}

// ==================== 百度地图加载 ====================

/** 动态加载百度地图 API */
function loadBMapScript(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.BMap !== 'undefined') {
      resolve();
      return;
    }

    // 使用唯一回调名称避免缓存冲突
    const ts = String(Date.now());
    const rand = String(Math.random()).slice(2, 8);
    const callbackName = '__bmap_cb_' + ts + '_' + rand;

    // 超时兜底 (15 秒); 纳入受管理定时器集合, 组件卸载时会被清理
    const timeoutId = setTimeout(() => {
      _timers.delete(timeoutId);
      Reflect.deleteProperty(window, callbackName);
      if (typeof window.BMap !== 'undefined') {
        resolve();
      } else {
        // 超时后仍然 resolve 以免组件卡住
        resolve();
      }
    }, 15000);
    _timers.add(timeoutId);

    // JSONP 回调挂到 window 上 (用 Object.assign 避免对 window 做索引签名断言)
    Object.assign(window, {
      [callbackName]: () => {
        clearTimeout(timeoutId);
        _timers.delete(timeoutId);
        Reflect.deleteProperty(window, callbackName);
        resolve();
      },
    });

    const script = document.createElement('script');
    script.src =
      'https://api.map.baidu.com/api?v=3.0&ak=' + import.meta.env.VITE_BAIDU_MAP_AK + '&callback=' +
      callbackName + '&t=' + ts;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeoutId);
      _timers.delete(timeoutId);
      Reflect.deleteProperty(window, callbackName);
      resolve();
    };
    document.head.appendChild(script);
  });
}

// ==================== 地图初始化 ====================

/** 初始化百度地图 */
async function initMap(): Promise<void> {
  try {
    const wrap = mapWrapRef.value;
    if (!wrap) return;

    // 确保百度地图 API 已加载
    await loadBMapScript();

    if (typeof window.BMap === 'undefined') {
      console.warn('[GpsMap] Baidu Maps API 加载失败');
      // FE-M7: 加载失败必须结束 loading, 否则 UI 永远显示"地图加载中..."
      mapLoading.value = false;
      return;
    }

    // 清理旧地图
    destroyMap();

    mapLoading.value = true;

    const B = getBMap();

    let centerLng = 0;
    let centerLat = 0;

    if (props.gpsPoints && props.gpsPoints.length > 0) {
      const bdPoints = props.gpsPoints.map(p => wgs84ToBd09(p.lat, p.lng));
      const sumLat = bdPoints.reduce((s, p) => s + p.lat, 0);
      const sumLng = bdPoints.reduce((s, p) => s + p.lng, 0);
      centerLat = sumLat / bdPoints.length;
      centerLng = sumLng / bdPoints.length;
    }

    // 创建地图实例
    bmap = new B.Map(wrap);

    if (!bmap) {
      console.warn('[GpsMap] B.Map 创建失败');
      mapLoading.value = false;
      return;
    }

    const centerPoint = new B.Point(centerLng, centerLat);
    bmap.centerAndZoom(centerPoint, 14);

    // 通知地图容器已可见
    setManagedTimeout(() => {
      try { bmap?.reset(); } catch {}
    }, 50);

    mapLoading.value = false;

    // 绘制 GPS 数据
    drawGpsData();
  } catch (e) {
    console.error('[GpsMap] 初始化失败:', e);
    mapLoading.value = false;
  }
}

/** 绘制 GPS 数据 */
function drawGpsData(): void {
  const B = getBMap();
  if (!B || !bmap) return;

  const map = bmap;
  const pts = props.gpsPoints;

  // 清除旧数据
  clearMapData();

  if (!pts || pts.length === 0) {
    return;
  }

  // 转换所有坐标: WGS84 -> BD09
  const bd09Points = pts.map(p => wgs84ToBd09(p.lat, p.lng));
  const bmapPts = bd09Points.map(p => new B.Point(p.lng, p.lat));

  // 轨迹线
  routeLine = new B.Polyline(bmapPts, {
    strokeColor: '#a29bfe',
    strokeWeight: 3,
    strokeOpacity: 0.8,
  });
  map.addOverlay(routeLine);

  // 标记点颜色
  const colors = ['#6c5ce7', '#00cec9', '#fdcb6e', '#fd79a8', '#74b9ff', '#ff6b6b', '#a29bfe', '#55efc4', '#f39c12', '#e17055'];

  // 记忆当前选中索引
  const currentIdx = selectedIndex.value;

  // 创建标记点
  pts.forEach((p, i) => {
    const colorIdx = i % colors.length;
    const color = colors[colorIdx];
    const count = p.count ?? 1;
    const size = count > 5 ? 11 : count > 2 ? 9 : 7;

    const isStart = i === 0;
    const isEnd = i === pts.length - 1;
    const markerColor = isStart ? '#00cec9' : isEnd ? '#ff6b6b' : color;

    const iconUrl = createMarkerIconUri(size, markerColor);
    const icon = new B.Icon(iconUrl, new B.Size(size, size), {
      anchor: new B.Size(size / 2, size / 2),
    });

    const marker = new B.Marker(bmapPts[i], { icon });
    const markerIdx = i;
    // 保存 handler 引用, 清理时才能精确解绑 (FE-L2)
    const handler = () => {
      selectPoint(markerIdx);
    };
    marker.addEventListener('click', handler);

    map.addOverlay(marker);
    markers.push({ marker, handler });
  });

  // 适应视图到所有点
  map.setViewport(bmapPts, { padding: 60 });

  // 点击地图空白区域取消选择
  mapClickHandler = () => {
    selectPoint(-1);
  };
  map.addEventListener('click', mapClickHandler);

  // 稳定后刷新尺寸
  setManagedTimeout(() => map.reset(), 300);

  // 恢复选择或默认选中最后一点
  if (currentIdx >= 0 && currentIdx < pts.length) {
    selectPoint(currentIdx);
  } else {
    selectPoint(pts.length - 1);
  }
}

/** 清除地图数据 (轨迹线 + 标记点 + 事件) */
function clearMapData(): void {
  if (!bmap) return;
  const map = bmap;

  // 移除地图点击事件
  if (mapClickHandler) {
    map.removeEventListener('click', mapClickHandler);
    mapClickHandler = null;
  }

  // 移除标记: 先解绑 click 监听 (FE-L2, 防泄漏/重复监听), 再移除覆盖物
  markers.forEach(({ marker, handler }) => {
    try {
      marker.removeEventListener('click', handler);
    } catch {
      // 地图实例已销毁时忽略
    }
    map.removeOverlay(marker);
  });
  markers = [];

  // 移除轨迹线
  if (routeLine) {
    map.removeOverlay(routeLine);
    routeLine = null;
  }
}

/** 选择点 */
function selectPoint(idx: number): void {
  selectedIndex.value = idx;

  if (idx < 0 || idx >= props.gpsPoints.length) {
    selectedPoint.value = null;
    return;
  }

  selectedPoint.value = props.gpsPoints[idx];
}

/** 销毁地图 */
function destroyMap(): void {
  clearMapData();
  if (bmap) {
    try {
      bmap.destroy();
    } catch {}
    bmap = null;
  }
}

// ==================== 监听变化 ====================

watch(
  () => props.visible,
  async (newVal) => {
    if (newVal) {
      // 禁止页面滚动 (锁 body + html + v2 壳层滚动容器)
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'
      lockShellBody()
      const dashPage = document.getElementById('page-dashboard')
      if (dashPage) dashPage.style.overflow = 'hidden'
      // 延迟初始化, 等待过渡动画完成
      await nextTick();
      focusTrap.activate();
      setManagedTimeout(initMap, 200);
    } else {
      // 恢复页面滚动
      focusTrap.deactivate();
      unlockShellBody();
      document.documentElement.style.overflow = ''
      document.body.style.overflow = ''
      const dashPage = document.getElementById('page-dashboard')
      if (dashPage) dashPage.style.overflow = ''
      // FE-M7: 清理未执行的延迟回调, 防止操作已销毁的地图
      clearManagedTimers();
      destroyMap();
      selectedIndex.value = -1;
      selectedPoint.value = null;
      mapLoading.value = true;
    }
  },
);

watch(
  () => props.gpsPoints,
  () => {
    if (props.visible && bmap) {
      drawGpsData();
    }
  },
  { deep: true },
);

// ==================== 生命周期 ====================

onUnmounted(() => {
  focusTrap.deactivate()
  unlockShellBody()
  document.documentElement.style.overflow = ''
  document.body.style.overflow = ''
  const dashPage = document.getElementById('page-dashboard')
  if (dashPage) dashPage.style.overflow = ''
  // FE-M7: 先清定时器再销毁地图, 避免延迟回调访问已销毁实例
  clearManagedTimers();
  destroyMap();
});
</script>

<style scoped>
/* ==================== 覆盖层基础 ==================== */

.gps-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 100vh;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  z-index: 9999;
  overflow: hidden;
  touch-action: none;
  overscroll-behavior: none;
}

/* 内容容器 - 移动端占满全屏 */
.gps-overlay-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
}

/* ==================== 头部 ==================== */

.gps-overlay-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  /* 顶部让出 --app-top-inset, 避免标题/关闭按钮被手机状态栏遮挡 */
  padding: calc(14px + var(--app-top-inset, 0px)) 20px 14px;
  flex-shrink: 0;
  background: var(--surface);
}

.gps-overlay-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}

.gps-overlay-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: var(--tap);
  min-block-size: var(--tap);
  background: transparent;
  border: 1px solid var(--hairline);
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  transition: background var(--motion-fast) ease;
}

.gps-overlay-close:hover {
  background: var(--surface2);
}

/* ==================== 地图容器 ==================== */

.gps-map-wrap {
  flex: 1;
  position: relative;
  min-height: 200px;
  overflow: hidden;
}

.gps-map-wrap :deep(.BMap_stdMpZoom) {
  /* 百度地图缩放控件的暗色适配 */
  filter: invert(0.85) hue-rotate(180deg);
}

.gps-map-loading {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text3);
  font-size: 13px;
}

.gps-map-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--surface3);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ==================== 点信息面板 (浮层) ==================== */

.gps-point-info {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  background: var(--surface);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  z-index: 100;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.pi-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.pi-index {
  font-size: 10px;
  color: var(--text3);
  font-family: 'Plus Jakarta Sans', monospace;
}

.pi-time {
  font-size: 13px;
  color: var(--text);
  font-weight: 600;
}

.pi-count {
  font-size: 10px;
  color: var(--text3);
  margin-left: 6px;
}

.pi-coord {
  font-size: 10px;
  color: var(--text2);
  font-family: 'Plus Jakarta Sans', monospace;
}

.pi-place {
  font-size: 12px;
  color: var(--primary-light);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.pi-place :deep(.icon) {
  font-size: 10px;
}

/* PC: GPS 地图作为模态框居中显示 */
@media (min-width: 768px) {
  .gps-overlay {
    align-items: center;
    justify-content: center;
    background: var(--overlay-bg);
  }

  .gps-overlay-content {
    max-width: 800px;
    max-height: 600px;
    width: 90vw;
    height: 70vh;
    border-radius: 12px;
    overflow: hidden;
    position: relative;
    background: var(--surface);
  }
}
</style>
