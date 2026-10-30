/**
 * GPS 数据类型
 *
 * 对应 /api/mobile/files/content?path=.../perception.jsonl 中的 GPS 数据
 * 以及 parseGpsFromPerception / mergeGpsPoints 处理流程
 */

// ==================== 原始 GPS 数据 ====================

/**
 * 感知数据对象 (perception.jsonl 中的单行对象)
 * 可能包含 GPS 信息，格式可为字符串 "lat,lng" 或数组 [{lat, lng}]
 */
export interface PerceptionObject {
  /** 时间字符串 (如 "12:00") */
  t?: string;
  /** GPS 位置 - 可能是 "lat,lng" 字符串 */
  gps?: string;
  /** 地点名称 */
  place?: string;
  /** 其他感知字段 */
  [key: string]: unknown;
}

/**
 * 解析后的原始 GPS 点
 * 由 parseGpsFromPerception 从 PerceptionObject[] 中提取
 */
export interface GpsRawPoint {
  /** 时间字符串 (如 "12:00") */
  t: string;
  /** 纬度 */
  lat: number;
  /** 经度 */
  lng: number;
  /** 地点名称 */
  place: string;
}

// ==================== 合并后的 GPS 点 ====================

/**
 * 合并后的 GPS 点 (地图标注/轨迹渲染使用)
 *
 * 兼容两种来源:
 *   - 原始点带时间字符串 `t`
 *   - useGps.mergeGpsPoints 产物带 timeStart/timeEnd/count (通常无 `t`)
 * 因此 `t` 与 timeStart/timeEnd 均为可选, 消费方需自行回退。
 */
export interface MergedGpsPoint {
  /** 时间字符串 (原始点字段; 合并点通常无此字段) */
  t?: string;
  /** 纬度 */
  lat: number;
  /** 经度 */
  lng: number;
  /** 地点名称 */
  place: string;
  /** 合并后起始时间 (mergeGpsPoints 产物) */
  timeStart?: string;
  /** 合并后结束时间 (mergeGpsPoints 产物) */
  timeEnd?: string;
  /** 合并计数 (该位置聚合的原始点数) */
  count?: number;
}

// ==================== 文件内容响应 ====================

/** /api/mobile/files/content 返回的 JSON 文件内容 */
export interface PerceptionFileContent {
  /** 感知数据对象数组 */
  objects: PerceptionObject[];
}

// ==================== 地图相关类型 ====================

/** GPS 预览画布渲染数据点 */
export interface GpsPreviewPoint {
  x: number;
  y: number;
  lat: number;
  lng: number;
  label: string;
}
