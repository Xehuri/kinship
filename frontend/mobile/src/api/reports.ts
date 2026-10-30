/**
 * 报告 API
 *
 * 对应:
 *   - /api/mobile/reports — 报告列表
 *   - /api/mobile/files/content?scope=root&path=... — 报告 Markdown 正文
 *
 * 视图层禁止内联 fetch + getToken, 统一经本模块访问报告相关接口。
 *
 * 使用方式:
 *   import { fetchReportContent } from '@/api/reports'
 */

import { apiGet } from '@/api/client';

/**
 * 获取报告 Markdown 正文 (以纯文本返回)
 *
 * @param path - 报告文件路径 (相对 ai/ 根目录)
 * @returns 正文文本; 请求失败返回 null
 */
export async function fetchReportContent(path: string): Promise<string | null> {
  const url =
    '/api/mobile/files/content?scope=root&path=' + encodeURIComponent(path);
  // asText=true: 强制按纯文本读取, 与报告 .md 正文语义一致
  return apiGet<string>(url, true);
}
