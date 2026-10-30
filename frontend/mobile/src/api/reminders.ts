/**
 * 提醒板 API
 *
 * GET /api/reminders → { text, updated_at }
 * text 是 AI 维护的单块提醒文本, updated_at 是 Unix 秒 (0 表示从未写入)。
 */

import { apiGet } from '@/api/client';

export interface RemindersBoard {
  text: string;
  updated_at: number;
}

export async function fetchReminders(): Promise<RemindersBoard | null> {
  return apiGet<RemindersBoard>('/api/reminders');
}
