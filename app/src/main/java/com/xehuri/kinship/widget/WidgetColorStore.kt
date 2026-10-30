package com.xehuri.kinship.widget

import android.content.Context

/**
 * WidgetCardColors - 卡片三配色槽位（背景对 / 文字对 / 遮罩开关）的不可变读取结果。
 *
 * 由 provideGlance 的 IO 段现读构造、作参数穿线进内容 Composable（组合内零阻塞 IO）。
 * 取证要点（daynight-colors.md §Q1/§Q3）：值型 ColorProvider(day,night) 在 API 31+ 以
 * 昼夜成对序列化进 RemoteViews、由宿主 apply 时按自身 uiMode 现场选色；API 26-30 则在
 * Glance 翻译期按 App 进程 uiMode 塌缩为单色固化——翻深浅色须靠 DataCollectorService
 * 的 uiMode receiver 重发 updateAll 重新翻译（T2 已落地），渲染端绝不手工预塌缩。
 *
 * - background / text: 日/夜 ARGB 对；(null, null) = 未设置，渲染端回退各自文件私有色板。
 *   store 读侧已保证"要么成对、要么全空"，半键在场一律视作未设。
 * - scrim: 可读性遮罩开关；prefs 键缺失 = true（无键态与现状渲染逐字节一致）。
 */
data class WidgetCardColors(
    val background: Pair<Int?, Int?>,
    val text: Pair<Int?, Int?>,
    val scrim: Boolean,
)

/**
 * WidgetColorPreset - 设置页（T6）配色预设：一名 + 背景/文字完整昼夜四色。
 * 全部 0xFF 不透明色值（PRESETS 内建项均满足），文字与其对应背景对比安全。
 */
data class WidgetColorPreset(
    val name: String,
    val bgDay: Int,
    val bgNight: Int,
    val textDay: Int,
    val textNight: Int,
)

/**
 * WidgetColorStore - 桌面卡片自定义配色存储（昼/夜成对 + 遮罩开关；T5 数据半区）
 *
 * 定位：AI 通知卡 / AI 提醒卡的"卡片底色 + 文字色"用户覆写。值为 Int 型 ARGB，
 * 渲染端以 [WidgetCardColors] 现读构造 ColorProvider(day,night) 值型对（禁自定义
 * ColorProvider 子类——glance 翻译器 `when` 只认 Fixed/Resource/DayNight 三类，
 * 未知子类掉 else 被静默丢弃，daynight-colors.md §3.3）。
 *
 * prefs 口径：独立 prefs 文件（store-per-prefs 约定，与 [WidgetBackgroundStore] 平级）；
 * cardKey 沿用背景 store 的同一字面量（"ai_notify" / "ai_reminder"——卡片标识跨 store
 * 共享命名，但各 store 的键各带自身前缀、互不引用对方常量，避免 store 间耦合）。
 * 每卡 5 键共 10 键：{card}_bg_day / {card}_bg_night / {card}_text_day /
 * {card}_text_night（可空 Int ARGB）+ {card}_scrim（Boolean）。
 *
 * 可空 Int 机制（锁死）：**键存在性只由 contains 判定**，getInt(key, 0) 的缺省 0
 * 永不可达——0x00000000 是合法全透明色，绝不允许用 0/-1 哨兵表达"未设置"。
 * 复位一律 remove(key) = 回代码默认。
 *
 * 成对不变式：写侧拒收半对（返回 false、prefs 分毫不动）；读侧半对在场视作未设。
 * scrim 写侧按冻结 API 走原生 prefs 键 "${cardKey}_scrim"（T6 设置页同源写入口径，
 * 键名由 WidgetColorStoreTest 钉死）。
 */
object WidgetColorStore {
    /** 独立 prefs 文件名（MODE_PRIVATE，同进程读写） */
    const val PREFS_NAME = "widget_color_store"

    /** AI 通知卡配色键（与 WidgetBackgroundStore.KEY_AI_NOTIFY 同字面量——键名共享、常量各自定义） */
    const val KEY_AI_NOTIFY = "ai_notify"

    /** AI 提醒卡配色键（同上，与背景 store 共享卡片标识字面量） */
    const val KEY_AI_REMINDER = "ai_reminder"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun bgDayKey(cardKey: String) = "${cardKey}_bg_day"
    private fun bgNightKey(cardKey: String) = "${cardKey}_bg_night"
    private fun textDayKey(cardKey: String) = "${cardKey}_text_day"
    private fun textNightKey(cardKey: String) = "${cardKey}_text_night"
    private fun scrimKey(cardKey: String) = "${cardKey}_scrim"

    /** 可空 Int 槽位读取：contains 判存在，缺省参数 0 永不可达（见类头"可空 Int 机制"） */
    private fun readArgb(context: Context, key: String): Int? {
        val sp = prefs(context)
        return if (sp.contains(key)) sp.getInt(key, 0) else null
    }

    /** 成对读取：两键齐备才返回 (day, night)，否则 (null, null)——半对在场视作未设 */
    private fun readPair(context: Context, dayKey: String, nightKey: String): Pair<Int?, Int?> {
        val day = readArgb(context, dayKey)
        val night = readArgb(context, nightKey)
        return if (day != null && night != null) day to night else null to null
    }

    /**
     * 成对写入：both-null → remove 两键（回默认，返回 true）；
     * both-present → put 两键（返回 true）；半对 → 拒写 false，prefs 分毫不动。
     */
    private fun writePair(
        context: Context,
        dayKey: String,
        nightKey: String,
        dayArgb: Int?,
        nightArgb: Int?,
    ): Boolean {
        val editor = prefs(context).edit()
        return when {
            dayArgb == null && nightArgb == null -> {
                editor.remove(dayKey).remove(nightKey).apply()
                true
            }
            dayArgb != null && nightArgb != null -> {
                editor.putInt(dayKey, dayArgb).putInt(nightKey, nightArgb).apply()
                true
            }
            else -> false // 半对拒绝：不创建任何持久化
        }
    }

    /** 读卡片背景昼夜对；未设置 → (null, null)（渲染端回文件私有色板） */
    fun readBackground(context: Context, cardKey: String): Pair<Int?, Int?> =
        readPair(context, bgDayKey(cardKey), bgNightKey(cardKey))

    /** 读卡片文字昼夜对；未设置 → (null, null)。设置后单一色同时压过主要/次要两角色 */
    fun readText(context: Context, cardKey: String): Pair<Int?, Int?> =
        readPair(context, textDayKey(cardKey), textNightKey(cardKey))

    /** 读可读性遮罩开关；键缺失 → true（与无键态现状渲染一致） */
    fun readScrim(context: Context, cardKey: String): Boolean =
        prefs(context).getBoolean(scrimKey(cardKey), true)

    /** 写卡片背景对（语义见 [writePair]；接受 0xFF 前缀不透明 Int） */
    fun writeBackground(context: Context, cardKey: String, dayArgb: Int?, nightArgb: Int?): Boolean =
        writePair(context, bgDayKey(cardKey), bgNightKey(cardKey), dayArgb, nightArgb)

    /** 写卡片文字对（语义同 [writeBackground]） */
    fun writeText(context: Context, cardKey: String, dayArgb: Int?, nightArgb: Int?): Boolean =
        writePair(context, textDayKey(cardKey), textNightKey(cardKey), dayArgb, nightArgb)

    /** 背景复位：remove 两键回色板默认；未设置时是无害空操作 */
    fun clearBackground(context: Context, cardKey: String) {
        prefs(context).edit().remove(bgDayKey(cardKey)).remove(bgNightKey(cardKey)).apply()
    }

    /** 文字复位：remove 两键回两档色板默认；未设置时是无害空操作 */
    fun clearText(context: Context, cardKey: String) {
        prefs(context).edit().remove(textDayKey(cardKey)).remove(textNightKey(cardKey)).apply()
    }

    /** #RRGGBB（大小写不敏感）→ 0xFF 前缀不透明 ARGB；非法输入（无 # / 位数差 / 非十六进制 / 带 alpha 8 位）一律 null */
    fun normalizeHex(input: String): Int? {
        if (!HEX_COLOR_PATTERN.matches(input)) return null
        // 6 位十六进制恒 ≤ 0xFFFFFF，Int 解析不溢出；高位并 0xFF 强制不透明
        return input.substring(1).toInt(16) or (0xFF shl 24)
    }

    /**
     * 8 套内建配色预设（T6 设置页选择器数据源）：每套 = 背景/文字完整昼夜对，
     * 全部 0xFF 不透明；日间浅底深字、夜间深底浅字，两态对比安全。
     * 首位"默认纸感"与两展示卡现行文件私有色板逐值相等（bg=底色对；文字取主要色档）。
     */
    val PRESETS: List<WidgetColorPreset> = listOf(
        WidgetColorPreset("默认纸感", 0xFFFFFFFF.toInt(), 0xFF2B2930.toInt(), 0xFF1D1B20.toInt(), 0xFFE6E1E5.toInt()),
        WidgetColorPreset("夜空蓝", 0xFFEAF2FB.toInt(), 0xFF16283F.toInt(), 0xFF17324D.toInt(), 0xFFD6E6F5.toInt()),
        WidgetColorPreset("松墨绿", 0xFFEAF4EE.toInt(), 0xFF1C2E25.toInt(), 0xFF1F3A2C.toInt(), 0xFFD5E8DC.toInt()),
        WidgetColorPreset("暖阳橙", 0xFFFFF3E4.toInt(), 0xFF33241A.toInt(), 0xFF4A2E12.toInt(), 0xFFF2DEC6.toInt()),
        WidgetColorPreset("玫瑰灰", 0xFFF9ECEE.toInt(), 0xFF332226.toInt(), 0xFF432229.toInt(), 0xFFEFD5DA.toInt()),
        WidgetColorPreset("深海青", 0xFFE6F4F4.toInt(), 0xFF14292B.toInt(), 0xFF11363A.toInt(), 0xFFCDE6E6.toInt()),
        WidgetColorPreset("暮山紫", 0xFFF1EBF7.toInt(), 0xFF261E33.toInt(), 0xFF35264A.toInt(), 0xFFE1D6EE.toInt()),
        WidgetColorPreset("石墨极简", 0xFFF2F2F2.toInt(), 0xFF1F1F1F.toInt(), 0xFF222222.toInt(), 0xFFE4E4E4.toInt()),
    )

    private val HEX_COLOR_PATTERN = Regex("^#[0-9a-fA-F]{6}$")
}
