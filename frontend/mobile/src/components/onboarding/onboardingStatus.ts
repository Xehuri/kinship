import type { DownloadJobState } from '@/api/system'

export function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2
  return `${amount.toFixed(digits)} ${units[unit]}`
}

const JOB_STATE_LABELS: Record<DownloadJobState, string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function jobStateLabel(state: DownloadJobState): string {
  return JOB_STATE_LABELS[state] ?? state
}

const KERNEL_SOURCE_LABELS: Record<string, string> = {
  release: '发行版',
  source: '源码检出',
  unknown: '未识别目录',
}

export function kernelSourceLabel(source: string | null | undefined): string {
  if (!source) return '未安装'
  return KERNEL_SOURCE_LABELS[source] ?? source
}

export function kernelGuardMessage(
  reason: string | null | undefined,
): string {
  switch (reason) {
    case 'kernel_install_forbidden_dev_checkout':
      return '检测到源码检出的内核（kernel/axeuh_kernel）。发行包不会覆盖源码目录；当前源码内核可继续使用，如需发行版请先在部署环境备份并移除源码目录。'
    case 'kernel_install_target_not_empty':
      return 'kernel/ 目录已有内容但缺少发行标记，安装被拒绝以避免覆盖。请先手动备份并清理该目录后重试。'
    case 'kernel_install_target_unreadable':
      return '无法读取 kernel/ 目录，安装被拒绝。请检查目录权限后重试。'
    default:
      return reason ? `安装被拒绝：${reason}` : ''
  }
}

const TIER_LABELS: Record<string, string> = {
  required: '必需',
  recommended: '推荐',
  optional: '可选',
}

export function modelTierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier
}

const TIER_DESCRIPTIONS: Record<string, string> = {
  required: '语音识别、声纹与说话人分离的基础模型，缺失时音频链路不可用。',
  recommended: '唤醒词等常用能力；建议保留。',
  optional: '环境声与场景分类；按需下载，可随时跳过。',
}

export function modelTierDescription(tier: string): string {
  return TIER_DESCRIPTIONS[tier] ?? '模型档位。'
}

const SOURCE_LABELS: Record<string, string> = {
  bundled: '随内核分发',
  modelscope: 'ModelScope',
  huggingface_gated: 'HuggingFace（受限）',
  upstream: '上游发布',
  release: '发行包',
}

export function modelSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}
