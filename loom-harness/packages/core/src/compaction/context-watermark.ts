/**
 * W57 P3：上下文水位提醒（持久 `<system-reminder>` notice）。
 *
 * 设计约束（用户 2026-10-19 拍板）：
 *   - 软提醒，不写"收敛"、不命令"必须准备压缩"；正在进行的任务不必中断。
 *   - 走 `<system-reminder>` 通道（与 assembly/context-change 同款模型侧标记），
 *     不拼 system prompt、不新增 store entry 类型——notice 就是一条普通 user-role message，
 *     由内核正常 flush 落盘，重启重放时据此恢复已提醒档位。
 *   - 档位与硬上限全部来自配置（`SessionCompactionOptions.watermarkLevels` /
 *     `fallbackTokens`），本模块零硬编码。
 *   - marker `[context-watermark:<level>]` 是持久坐标：level 为绝对 token 数（非 k），
 *     压缩边界对齐、摘要输入与重放扫描都靠它识别并跳过 notice。
 *
 * 本模块是纯函数（零 IO、零 session 依赖），只依赖 pi-ai `Message` 类型与
 * `createUserMessage`，避免 `session.ts → context-watermark.ts → session.ts` 的环。
 */

import type { Message } from "@earendil-works/pi-ai";
import { createUserMessage } from "../types.js";

/** marker 前缀；同一条 notice 只出现一次，后接绝对 token 档位与 `]`。 */
export const CONTEXT_WATERMARK_MARKER_PREFIX = "[context-watermark:";

/** 单条 notice 的构造输入。 */
export interface ContextWatermarkMessageInput {
  /** 本次跨过的最高档位（绝对 token 数，> 0）。 */
  readonly level: number;
  /** 发出提醒时的请求体积估算；只用于文案读数，不参与档位判定。 */
  readonly estimatedTokens: number;
  /** 兜底硬上限（绝对 token 数），即 `fallbackTokens`。 */
  readonly hardCap: number;
  /** 本档是否为**最高**配置档；true 时文案追加自动兜底说明。 */
  readonly isHighest?: boolean;
  /** 时钟覆盖（测试确定性）；缺省 `Date.now()`。 */
  readonly now?: number;
}

/** 生成某档位的 marker 原文。 */
export function contextWatermarkMarker(level: number): string {
  return `${CONTEXT_WATERMARK_MARKER_PREFIX}${String(level)}]`;
}

/** 读取消息正文（string content 或 text 块拼接）。 */
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const block of message.content) {
    if ("text" in block && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * 是否为水位提醒消息：必须同时满足 user role + 正文含 marker。
 * 只认 marker 前缀（不要求 level 可解析），损坏的 marker 仍不会被当作真实用户轮次。
 */
export function isContextWatermarkMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  return messageText(message).includes(CONTEXT_WATERMARK_MARKER_PREFIX);
}

/**
 * 从水位提醒消息中解析绝对档位；非 notice / marker 损坏返回 null。
 * 用于重放时恢复 `_lastWatermarkLevel`，避免重启后同档位重复提醒。
 */
export function contextWatermarkLevel(message: Message): number | null {
  if (message.role !== "user") return null;
  const match = /\[context-watermark:(\d+)\]/.exec(messageText(message));
  if (match === null) return null;
  const level = Number(match[1]);
  return Number.isSafeInteger(level) && level > 0 ? level : null;
}

/**
 * 构造一条水位提醒消息。文案保持软提醒；只有最高配置档追加"系统会自动压缩兜底"。
 * marker 单独成行放在 `<system-reminder>` 包裹之外，提醒正文与约定逐字一致。
 */
export function buildContextWatermarkMessage(input: ContextWatermarkMessageInput): Message {
  const lines = [
    contextWatermarkMarker(input.level),
    "<system-reminder>",
    `上下文水位：约 ${formatThousands(input.estimatedTokens)}k / ${formatThousands(input.hardCap)}k。`,
    "如果当前没有未完成事项，可以调用 compact_context 压缩会话；正在进行的任务不必因此中断。",
  ];
  if (input.isHighest === true) {
    lines.push(`达到 ${formatThousands(input.hardCap)}k 时系统会自动压缩兜底。`);
  }
  lines.push("</system-reminder>");
  const message = createUserMessage(lines.join("\n"));
  return input.now === undefined ? message : { ...message, timestamp: input.now };
}

/** 取严格小于 `estimatedTokens` 的最高档位；无命中返回 0（0 = 不发提醒）。 */
export function highestWatermarkLevelAtOrBelow(
  levels: readonly number[],
  estimatedTokens: number,
): number {
  let highest = 0;
  for (const level of levels) {
    if (level <= estimatedTokens && level > highest) highest = level;
  }
  return highest;
}

/**
 * 构造期校验：每档必须是有限正整数、严格递增、且全部小于 `fallbackTokens`。
 * 违反即抛 `RangeError`（fail-loud，不允许静默吞掉错配的档位）。
 */
export function assertValidWatermarkLevels(
  levels: readonly number[] | undefined,
  fallbackTokens: number,
): void {
  if (levels === undefined) return;
  let previous = 0;
  for (const [index, level] of levels.entries()) {
    if (!Number.isSafeInteger(level) || level <= 0) {
      throw new RangeError(
        `watermarkLevels[${String(index)}] must be a finite integer > 0 (got ${String(level)})`,
      );
    }
    if (level <= previous) {
      throw new RangeError(
        `watermarkLevels must be strictly increasing (index ${String(index)}: ` +
          `${String(level)} <= ${String(previous)})`,
      );
    }
    if (level >= fallbackTokens) {
      throw new RangeError(
        `watermarkLevels[${String(index)}] (${String(level)}) must be < fallbackTokens ` +
          `(${String(fallbackTokens)})`,
      );
    }
    previous = level;
  }
}

/** 文案里的 k 读数：四舍五入到千位，避免 299999 显示成 299k 的观感偏差。 */
function formatThousands(tokens: number): number {
  return Math.round(tokens / 1000);
}
