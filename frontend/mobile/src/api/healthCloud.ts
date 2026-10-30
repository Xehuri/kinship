/**
 * 小米健康云 API
 *
 * 对应 /api/health/cloud/*：状态、开关、扫码登录、立即同步。
 */

import { apiGet, apiPost } from '@/api/client'

export type HealthCloudPhase =
  | 'disabled'
  | 'unconfigured'
  | 'auth_expired'
  | 'error'
  | 'ok'
  | 'syncing'

export interface HealthCloudStatus {
  enabled: boolean
  configured: boolean
  phase: HealthCloudPhase
  userid: string
  region: string
  poll_interval_min: number
  overlap_days: number
  last_attempt: number | null
  last_success: number | null
  watermark: number | null
  last_error: string
  last_batches: number
  consecutive_failures: number
  latest_cloud_shard: string
}

export interface HealthCloudQr {
  lp: string
  qr_base64: string
  expires_in: number
  login_url?: string
}

export interface HealthCloudQrPoll {
  state: 'waiting' | 'success'
  user_id?: string
}

export interface HealthCloudSyncResult {
  ok: boolean
  written: number
  since?: number
}

export async function fetchHealthCloudStatus(
  probe = false,
): Promise<HealthCloudStatus | null> {
  return apiGet<HealthCloudStatus>(
    '/api/health/cloud/status' + (probe ? '?probe=true' : ''),
  )
}

export async function setHealthCloudEnabled(
  enabled: boolean,
): Promise<HealthCloudStatus | null> {
  return apiPost<HealthCloudStatus>('/api/health/cloud/enable', { enabled })
}

export async function requestHealthCloudQr(): Promise<HealthCloudQr | null> {
  return apiPost<HealthCloudQr>('/api/health/cloud/qr', {})
}

export async function pollHealthCloudQr(
  lp: string,
): Promise<HealthCloudQrPoll | null> {
  return apiPost<HealthCloudQrPoll>('/api/health/cloud/qr/poll', { lp })
}

export async function syncHealthCloud(
  days?: number,
): Promise<HealthCloudSyncResult | null> {
  return apiPost<HealthCloudSyncResult>(
    '/api/health/cloud/sync',
    days ? { days } : {},
  )
}
