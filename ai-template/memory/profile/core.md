---
tags: [记忆, 用户画像, 导航]
type: profile/core
date: {date}
---
# profile/core.md：用户画像树（L1 全景 + 细节摘要 + 导航）

> 本文件是子智能体唯一的用户认知入口。细节在此给足；完整编年史在 `semantic/`，需要追溯事件脉络或证据链时再读。当下动态见 `profile/state.md`，热快照见 `self/必读.md`（AI 工作台，性质不同）。

> 更新规则：复盘收割时若语义层有变，同步刷新本文件对应节；长期稳定节只在真值变化时改。

## 他是谁（根）

- 称呼：{用户称呼}；网络 ID 或项目代号：{项目名称}
- 生日与年龄口径：{date} 记录，待用户确认
- 自我定位与核心价值：（待填，一行一项）
- 能力与作品：（待填，每条一句话带日期）

## 学业（分叉 → 事项/）

- 学校、专业、阶段：（待填）
- 目标与考试时间：（待填）
- 当前进度口径：（待填，只写当前态）
- → 详情与编年史：[[memory/profile/semantic/事项/{事项}]]

## 关系（分叉 → semantic/people/）

- {人物}：关系、稳定事实、注意点 → [[memory/profile/semantic/people/{人物}]]
- 关系雷区：（待填，只写用户明确说过的边界）

## 偏好与禁忌（分叉 → semantic/偏好与禁忌）

- 沟通禁忌：（待填）
- 饮食、审美、消费：（待填）
- 对 AI 的要求：（待填）
- → [[memory/profile/semantic/偏好与禁忌]]

## 健康基线（分叉 → semantic/健康基线）

- 长期关注项：（待填）
- 数据口径：（待填）
- → [[memory/profile/semantic/健康基线]]

## 行为规律（分叉 → semantic/行为规律）

- 可复用的真模式：（待填，一条一行）
- → [[memory/profile/semantic/行为规律]]

## 资产与进行中事项（只列进行中）

- {事项}：一句话进展 → [[memory/profile/semantic/事项/{事项}]]

## 常去地点（分叉 → semantic/常去地点）

- 居住与活动片区：（待填）
- → [[memory/profile/semantic/常去地点]]

## 当下（动态层）

- [[memory/profile/state|当前状态快照]]
- 事件检索 → `analysis/query_catalog.py`；旧日期回 `data/daily/` 的复盘/理解

## 档案地图（目录导航）

```text
profile/
├── core.md          ← 本文件（L1 全景 + 细节摘要 + 导航）
├── core-lite.md     ← 主会话画像投影
├── state.md         ← 当前状态快照
├── 规律.md           ← 当前成立的规律
├── 规律-摘要.md      ← 规律机载摘要
├── events/          ← 单次事件
└── semantic/        ← 主题档案
    ├── people/      ← 人物档案
    ├── 事项/         ← 事项编年史
    └── 偏好与禁忌.md 健康基线.md 行为规律.md 常去地点.md
```

> 设计原则：profile 存用户的客观事实；AI 的推断与印象住 `self/认知.md`。指针不复制，编年史不归档。
