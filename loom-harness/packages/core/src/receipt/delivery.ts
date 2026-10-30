/**
 * T14 回执投递端口 + 主会话收件格式。
 *
 * 副会话回执**默认直投主会话**（D23 协作主干，带【副会话回执】前缀）。
 * 本模块只定义「搬运通道」的**注入端口**：真搬运（经账本/T10 deliver 收件箱）由装配层
 * 实现；core 与测试用 MemoryReceiptDelivery。回执经账本投递主会话的钩子 = 注入函数。
 *
 * 为什么是端口：core 不 import adapters/main-loop 实现（避免包级循环）；
 * server 装配时把「写进 deliver 收件箱」的闭包传进来即可满足本端口。
 */

import type { HarnessReceipt } from "./types.js";

/** 副会话回执标记（与 convergence 的 DEAD_LETTER_MARK 同族；主会话据此识别）。 */
export const RECEIPT_MARK = "【副会话回执】" as const;

/** 投递端口：把持久化回执投进主会话（实现方决定搬运细节）。 */
export interface ReceiptDeliveryPort {
  deliver(receipt: HarnessReceipt): void | Promise<void>;
}

/**
 * 回执 → 主会话 deliver 文本（一行摘要 + 预验块；主默认只读 digest，异常才深挖）。
 * 纯格式装配，无副作用。
 */
export function receiptMessage(receipt: HarnessReceipt): string {
  const v = receipt.verification;
  return (
    `${RECEIPT_MARK}run=${receipt.run_id} workflow=${receipt.workflow} ` +
    `attempt=${receipt.attempt} status=${receipt.status} ` +
    `[manifest=${v.manifest.verdict} commit_body=${v.commit_body.verdict} coverage=${v.coverage.verdict}]：` +
    receipt.digest
  );
}

/** 内存投递假件：记录投递回执（测试观察对象 + server 接线前占位）。 */
export class MemoryReceiptDelivery implements ReceiptDeliveryPort {
  private readonly _delivered: HarnessReceipt[] = [];

  get delivered(): readonly HarnessReceipt[] {
    return this._delivered;
  }

  deliver(receipt: HarnessReceipt): void {
    this._delivered.push(receipt);
  }
}
