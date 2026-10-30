/**
 * 类型统一导出入口
 *
 * 使用方式: import type { ApiResponse, HealthSample, ... } from '@/types'
 */

export type {
  ApiResponse,
  LoginRequest,
  LoginResponse,
  SSEEvent,
  SSEPayload,
  SSEProperties,
  SSESessionQueueItem,
  SSEMessagePart,
} from './api';

export type {
  HealthSample,
  DailySummary,
  SleepStageType,
  SleepStage,
  SleepData,
  HealthQueryResponse,
  HealthSummary,
  PerceptionSummary,
  BatteryTimelineEntry,
  DashboardResponse,
  BlockSize,
  BlockStat,
  BlockConfig,
  BlockDetailsMap,
  HealthQueryResponse as HealthResult,
  DashboardResponse as DashResult,
} from './health';

export {
  SLEEP_STAGE_COLORS,
  SLEEP_STAGE_LABELS,
  SLEEP_STAGE_ORDER,
} from './health';

export type {
  SessionInfo,
  SessionListResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  SwitchSessionRequest,
  MessageRole,
  MessagePartType,
  MessagePart,
  ChatMessage,
  MessagesResponse,
  TokenUsage,
  StreamCollapsedMap,
} from './chat';

export type {
  PerceptionObject,
  GpsRawPoint,
  MergedGpsPoint,
  PerceptionFileContent,
  GpsPreviewPoint,
} from './gps';

export type {
  FileEntryType,
  FileIconClass,
  FileEntry,
  FileTreeResponse,
  FileContentJsonResponse,
  FileSearchQuery,
} from './files';

export type {
  ReportTag,
  ReportKind,
  ReportFamily,
  ReportFamilyFilter,
  ReportFamilyCounts,
  ReportFamilyCount,
  ReportItem,
  ReportListResponse,
  ReportFilter,
} from './reports';

export {
  FAMILY_LABELS,
  REPORT_FAMILY_ORDER,
  resolveReportFamily,
} from './reports';

export type {
  VpCharToken,
  VpResult,
  VpSegment,
  VpTag,
  VpRecord,
  VpTimeline,
  VpStats,
  VpAudioState,
} from './voiceprint';

export type {
  TurnAttachment,
  ThinkingStep,
  ToolResultView,
  ToolStep,
  ToolStatus,
  CompactionStep,
  TurnStep,
  TurnTerminal,
  TurnTerminalReason,
  TurnView,
} from './turn';

export type {
  PlanItemKind,
  PlanItemStatus,
  PlanStatus,
  PlanCoverageProfile,
  LongTaskCadence,
  LongTaskStatus,
  LongTaskReviewPolicy,
  PlanItem,
  PlanCoverage,
  PlanDocument,
  LongTask,
  PlanDayResponse,
  PlanLongTasksResponse,
} from './plan';
