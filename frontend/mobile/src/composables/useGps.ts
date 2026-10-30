/**
 * GPS Composable — GPS 原始数据、合并去重、地图状态
 *
 * 管理 GPS 原始数据解析、邻近点合并去重 (减少渲染量)、
 * 选中点索引、以及地图/预览渲染状态。
 *
 * 使用方式:
 *   const { gpsRawPoints, gpsPointData, gpsSelectedIdx, loadGpsData } = useGps()
 *   await loadGpsData('2026-06-22')
 *   // 合并后的点自动通过 computed 更新
 *   gpsSelectedIdx.value = 3  // 选中第 4 个点
 */

import { ref, computed, readonly, type Ref, type ComputedRef } from 'vue';
import type { GpsRawPoint, PerceptionObject } from '@/types';
import { fetchFileContent } from '@/api/files';

// ==================== 局部类型 ====================

/**
 * 合并后的 GPS 点 (带开始/结束时间)
 * 由 mergeGpsPoints 返回, 用于渲染和地图标注
 */
export interface GpsMergedPoint {
  /** 纬度 */
  lat: number;
  /** 经度 */
  lng: number;
  /** 地点名称 */
  place: string;
  /** 开始时间 */
  timeStart: string;
  /** 结束时间 */
  timeEnd: string;
  /** 合并计数 (该位置聚合的原始点数) */
  count: number;
}

// ==================== 类型定义 ====================

/** useGps 返回值 */
export interface UseGpsReturn {
  /** 原始 GPS 点列表 (从 perception.jsonl 解析) */
  gpsRawPoints: Ref<GpsRawPoint[]>;
  /** 合并去重后的 GPS 点 (用于渲染) */
  gpsPointData: ComputedRef<GpsMergedPoint[]>;
  /** 选中点索引 (地图/信息展示) */
  gpsSelectedIdx: Ref<number>;
  /** 是否有 GPS 数据 */
  hasData: ComputedRef<boolean>;
  /** 加载中 */
  loading: Readonly<Ref<boolean>>;
  /**
   * 加载指定日期的 GPS 数据
   * 从 perception.jsonl 解析并合并
   * @param date YYYY-MM-DD 格式日期
   */
  loadGpsData: (date: string) => Promise<void>;
  /**
   * 从感知数据对象列表解析 GPS 点
   * @param objects 感知数据对象
   * @returns 解析后的原始 GPS 点
   */
  parseGpsFromPerception: (objects: PerceptionObject[]) => GpsRawPoint[];
  /**
   * 合并去重邻近 GPS 点
   * 将连续相同 lat/lng 的点合并, 减少渲染量
   * @param points 原始 GPS 点
   * @returns 合并后的点
   */
  mergeGpsPoints: (points: GpsRawPoint[]) => GpsMergedPoint[];
  /** 清空 GPS 数据 */
  clearGpsData: () => void;
}

// ==================== Composable ====================

/**
 * GPS Composable — GPS 原始数据、合并去重、地图状态
 *
 * 从 perception.jsonl 中解析 GPS 数据,
 * 使用 mergeGpsPoints 合并邻近点以减少渲染量。
 */
export function useGps(): UseGpsReturn {
  const gpsRawPoints = ref<GpsRawPoint[]>([]);
  const gpsSelectedIdx = ref(0);
  const loading = ref(false);

  /**
   * 合并去重后的 GPS 点 (自动随 raw 更新)
   *
   * 将连续相同位置的点合并, 减少渲染量。
   */
  const gpsPointData = computed<GpsMergedPoint[]>(() => {
    return mergeGpsPoints(gpsRawPoints.value);
  });

  /** 是否有 GPS 数据 */
  const hasData = computed<boolean>(() => {
    return gpsPointData.value.length > 0;
  });

  // ==================== 数据解析 ====================

  /**
   * 从感知数据对象列表解析 GPS 点
   *
   * 支持两种 GPS 格式:
   *   1. gps = "lat,lng" (字符串)
   *   2. gps = [{lat, lng}] (数组)
   *
   * @param objects 感知数据对象 (perception.jsonl 解析结果)
   * @returns 解析后的原始 GPS 点
   */
  function parseGpsFromPerception(
    objects: PerceptionObject[],
  ): GpsRawPoint[] {
    const points: GpsRawPoint[] = [];

    for (const obj of objects) {
      let lat: number | undefined;
      let lng: number | undefined;

      // 格式1: gps = "lat,lng" (字符串)
      if (typeof obj.gps === 'string' && obj.gps.indexOf(',') > 0) {
        const parts = obj.gps.split(',');
        lat = parseFloat(parts[0]);
        lng = parseFloat(parts[1]);
      }

      // 格式2: gps = [{lat, lng}] (数组)
      if (lat == null && Array.isArray(obj.gps)) {
        for (const g of obj.gps) {
          const gItem = g as Record<string, unknown>;
          if (
            gItem.lat !== undefined &&
            gItem.lng !== undefined
          ) {
            lat = gItem.lat as number;
            lng = gItem.lng as number;
            break;
          }
        }
      }

      if (lat != null && lng != null) {
        points.push({
          t: obj.t || '12:00',
          lat,
          lng,
          place: (obj.place as string) || '未知位置',
        });
      }
    }

    return points;
  }

  /**
   * 合并去重邻近 GPS 点
   *
   * 将连续相同 lat/lng 的原始点合并为一个,
   * 记录 timeStart/timeEnd 和 count。
   *
   * @param points 原始 GPS 点
   * @returns 合并后的点
   */
  function mergeGpsPoints(points: GpsRawPoint[]): GpsMergedPoint[] {
    const merged: GpsMergedPoint[] = [];

    for (const p of points) {
      const last = merged[merged.length - 1];

      if (
        last &&
        last.lat === p.lat &&
        last.lng === p.lng
      ) {
        // 相同位置: 更新结束时间, 增加计数
        last.timeEnd = p.t;
        last.count++;
      } else {
        // 不同位置: 新增条目
        merged.push({
          lat: p.lat,
          lng: p.lng,
          place: p.place,
          timeStart: p.t,
          timeEnd: p.t,
          count: 1,
        });
      }
    }

    return merged;
  }

  // ==================== 数据加载 ====================

  /**
   * 加载指定日期的 GPS 数据
   *
   * 从 perception.jsonl 中解析 GPS 数据,
   * 自动进行合并去重。
   *
   * @param date YYYY-MM-DD 格式日期
   */
  async function loadGpsData(date: string): Promise<void> {
    loading.value = true;
    gpsRawPoints.value = [];

    try {
      const result = await fetchFileContent('data/daily/' + date + '/perception.jsonl');

      if (
        result &&
        typeof result === 'object' &&
        'objects' in result &&
        Array.isArray(result.objects) &&
        result.objects.length > 0
      ) {
        const objects = result.objects as PerceptionObject[];
        const gpsPoints = parseGpsFromPerception(objects);

        if (gpsPoints.length > 0) {
          gpsRawPoints.value = gpsPoints;
          gpsSelectedIdx.value = 0;
          return;
        }
      }

      // 无数据: 保持空数组
      gpsRawPoints.value = [];
      gpsSelectedIdx.value = 0;
    } catch (e) {
      console.warn('[useGps] GPS 数据加载失败 (可能无 perception.jsonl):', e);
      gpsRawPoints.value = [];
      gpsSelectedIdx.value = 0;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 清空 GPS 数据
   */
  function clearGpsData(): void {
    gpsRawPoints.value = [];
    gpsSelectedIdx.value = 0;
  }

  return {
    gpsRawPoints,
    gpsPointData,
    gpsSelectedIdx,
    hasData,
    loading: readonly(loading),
    loadGpsData,
    parseGpsFromPerception,
    mergeGpsPoints,
    clearGpsData,
  };
}

// ==================== 单例 ====================

let _singleton: UseGpsReturn | null = null;

/**
 * 全局单例 useGps (跨组件共享同一个 GPS 数据)
 */
export function useGpsSingleton(): UseGpsReturn {
  if (!_singleton) {
    _singleton = useGps();
  }
  return _singleton;
}
