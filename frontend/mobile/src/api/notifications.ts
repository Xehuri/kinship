/**
 * 通知历史 API
 *
 * GET    /api/notification/history      → { notifications, total }
 * DELETE /api/notification/history/{id} → { status: 'ok' }
 *
 * 数据由后端通知历史接口提供, 前端不伪造、不推断已读状态。
 */

import { apiDelete, apiGet } from '@/api/client';

export interface NotificationItem {
  id: number;
  title: string;
  content: string;
  created_at: number;
}

export interface NotificationHistory {
  notifications: NotificationItem[];
  total: number;
}

/** 读取通知历史 (失败返回 null, 由调用方标记错误态) */
export function fetchNotificationHistory(): Promise<NotificationHistory | null> {
  return apiGet<NotificationHistory>('/api/notification/history');
}

/** 删除单条通知 (失败返回 null) */
export function deleteNotification(id: number): Promise<{ status: string } | null> {
  return apiDelete<{ status: string }>(`/api/notification/history/${id}`);
}
