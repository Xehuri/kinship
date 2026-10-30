package com.xehuri.kinship.widget

/**
 * ReminderBoardFingerprint - AI 提醒公告板纯指纹（widget 重绘前变更判重单实现）
 *
 * 公告板 v2 契约 = 整块 (text, updated_at 秒) 两键（见 ReminderStore）。采集服务的 5 秒
 * 提醒子节拍同步成功后读本地板、经 [of] 算指纹，与上次已渲染指纹不同才触发
 * ReminderWidget updateAll——Glance updateAll 每次跑异步会话、秒级抖动
 * （见 AiNotifyWidget.kt 首帧守卫处注释），必须把重绘频率压到最低。
 *
 * 指纹形态："updated_at|text" 字符串。updated_at 恒为 Long（仅数字与负号），首个 '|'
 * 因此不可能落在时间部分内，text 逐字全量保留——任何一字节变化必换指纹，空板 ""
 * 与非空板天然可区分，无需哈希（哈希有碰撞漏刷风险，2000 字上限的板面存内存串代价为零）。
 * 纯函数、零 Android 依赖，单测直接构造入参覆盖。
 */
object ReminderBoardFingerprint {

    /** 由整板 (text, updated_at 秒) 计算可比对指纹：同板同值；text 或 updated_at 任一变化即不同值 */
    fun of(text: String, updatedAtSeconds: Long): String = "$updatedAtSeconds|$text"
}
