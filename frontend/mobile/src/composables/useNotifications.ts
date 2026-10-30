/**
 * 通知历史 Composable
 *
 * 模块级单例: 浮动铃铛 (App) 与提醒页的「通知历史」入口共享同一个抽屉状态,
 * 任意入口 open() 后由 App 中唯一渲染的 NotificationsDrawer 呈现。
 *
 * 数据完全来自 GET /api/notification/history; 删除走 DELETE 同一资源。
 * 不伪造通知, 不发明已读状态。
 */

import { readonly, ref, type Ref } from 'vue';
import {
  deleteNotification as deleteNotificationRequest,
  fetchNotificationHistory,
  type NotificationItem,
} from '@/api/notifications';

export type NotificationsState = 'idle' | 'loading' | 'success' | 'error';

export interface UseNotificationsReturn {
  /** 抽屉是否打开 */
  visible: Readonly<Ref<boolean>>;
  /** 通知列表 (服务端返回顺序: 时间倒序) */
  notifications: Readonly<Ref<readonly NotificationItem[]>>;
  /** 服务端通知总数 */
  total: Readonly<Ref<number>>;
  /** 加载状态 */
  state: Readonly<Ref<NotificationsState>>;
  /** 正在删除的通知 id, null 表示空闲 */
  deletingId: Readonly<Ref<number | null>>;
  /** 打开抽屉并拉取最新历史 */
  open: () => Promise<void>;
  /** 关闭抽屉 */
  close: () => void;
  /** 切换抽屉 */
  toggle: () => Promise<void>;
  /** 重新拉取历史 (失败重试也走这里) */
  load: () => Promise<void>;
  /** 删除一条通知, 成功返回 true */
  deleteNotification: (id: number) => Promise<boolean>;
}

export function useNotifications(): UseNotificationsReturn {
  const visible = ref(false);
  const notifications = ref<NotificationItem[]>([]);
  const total = ref(0);
  const state = ref<NotificationsState>('idle');
  const deletingId = ref<number | null>(null);

  /** 请求序号: 乱序返回时只接受最后一次请求的结果 */
  let loadSequence = 0;

  async function load(): Promise<void> {
    const sequence = ++loadSequence;
    state.value = 'loading';

    const data = await fetchNotificationHistory();
    if (sequence !== loadSequence) {
      return;
    }

    if (!data || !Array.isArray(data.notifications)) {
      notifications.value = [];
      total.value = 0;
      state.value = 'error';
      return;
    }

    notifications.value = data.notifications;
    total.value = typeof data.total === 'number' ? data.total : data.notifications.length;
    state.value = 'success';
  }

  async function open(): Promise<void> {
    visible.value = true;
    await load();
  }

  function close(): void {
    visible.value = false;
  }

  async function toggle(): Promise<void> {
    if (visible.value) {
      close();
      return;
    }
    await open();
  }

  async function remove(id: number): Promise<boolean> {
    if (deletingId.value !== null) {
      return false;
    }

    deletingId.value = id;
    try {
      const result = await deleteNotificationRequest(id);
      if (result === null) {
        return false;
      }

      notifications.value = notifications.value.filter((item) => item.id !== id);
      total.value = Math.max(0, total.value - 1);
      return true;
    } finally {
      deletingId.value = null;
    }
  }

  return {
    visible: readonly(visible),
    notifications: readonly(notifications),
    total: readonly(total),
    state: readonly(state),
    deletingId: readonly(deletingId),
    open,
    close,
    toggle,
    load,
    deleteNotification: remove,
  };
}

// ==================== 单例 ====================

let singleton: UseNotificationsReturn | null = null;

/** 全局单例: App 与提醒页共享同一抽屉状态 */
export function useNotificationsSingleton(): UseNotificationsReturn {
  if (!singleton) {
    singleton = useNotifications();
  }
  return singleton;
}
