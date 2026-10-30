---
tags: [模板, 记忆, 用户画像]
type: template
date: {date}
---
# profile/core.md（画像树：L1 全景 + 细节摘要 + 导航）

> 子智能体的用户认知入口。树状结构：从「他是谁」向下分叉细化。节点 = 概要（一句话带日期），叶子 = 档案链接。
> 不复制正文，细节在 semantic/ 档案。动态状态见 state.md，热快照见 self/必读，规律见 规律.md。
> 更新：复盘收割致 semantic 变化时，同步刷新对应概要行。

## 他是谁（根）

- 称呼：{用户称呼}；网络 ID 或项目代号：{项目名称}
- 生日与年龄口径：{date} 记录，待用户确认
- 自我定位、核心价值、能力与作品（每条一句话带日期）

## 学业（分叉 → 事项/）

- 学校、专业、阶段、目标与当前进度概要 → [[memory/profile/semantic/事项/{事项}]]

## 关系（分叉 → semantic/people/）

- 伴侣、家人、核心人物一行概要 → [[memory/profile/semantic/people/{人物}]]
- 关系雷区：只写用户明确说过的边界。

## 偏好与禁忌（分叉 → 属性档）

- 禁忌、雷区、消费观概要 → [[memory/profile/semantic/偏好与禁忌]]

## 健康基线

- 持续关注项与数据口径概要 → [[memory/profile/semantic/健康基线]]

## 行为规律

- 可复用真模式概要 → [[memory/profile/semantic/行为规律]]

## 资产与进行中事项（只列进行中）

- 活跃项目一行概要 → [[memory/profile/semantic/事项/{事项}]]

## 常去地点

- 居住与活动片区概要 → [[memory/profile/semantic/常去地点]]

## 当下（动态）

- → [[memory/profile/state]]，不在此累积。

## 档案地图（目录导航）

```text
profile/
├── core.md          ← 本文件
├── core-lite.md     ← 主会话画像投影
├── state.md         ← 当前状态快照
├── 规律.md           ← 当前成立的规律
├── 规律-摘要.md      ← 规律机载摘要
├── events/          ← 单次事件
└── semantic/        ← 主题档案（people/、事项/、属性四文件）
```
