/**
 * Axeuh 系统信封清洗
 *
 * Loom 的 session.queue 与 OpenCode 用户 part 携带的消息文本可能包在
 * <Axeuh-home-system> ... </Axeuh-home-system> 信封里 (桥接/checkpoint/mode
 * 等系统注入内容), 而本地乐观气泡只存用户原文。两侧比较前必须剥离信封,
 * 否则同一条消息会被当成两条渲染。
 *
 * 语义与后端 backend/routers/session.py 的 _extract_user_text 意图一致:
 * 只保留 </Axeuh-home-system> 之后的真实用户文本; 这里取最后一个闭合
 * 标签, 以兼容信封内部再次嵌套同名标签的情况。
 */

const AXEUH_HOME_SYSTEM_CLOSE_TAG = '</Axeuh-home-system>'

/**
 * 取最后一个 `</Axeuh-home-system>` 之后的文本 (去首尾空白)。
 *
 * 不含该闭合标签时原样返回 (不做其他模式的退化剥离), 保证 "没有信封"
 * 的文本逐字不变。
 */
export function stripAxeuhHomeSystem(text: string): string {
  const idx = text.lastIndexOf(AXEUH_HOME_SYSTEM_CLOSE_TAG)
  if (idx < 0) return text
  return text.slice(idx + AXEUH_HOME_SYSTEM_CLOSE_TAG.length).trim()
}
