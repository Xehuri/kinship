/**
 * 演示模式消息 — 未登录/演示开关时在聊天界面显示的测试对话
 *
 * 统一演示数据源 (原 MOCK_MESSAGES 硬编码已并入本文件)。
 * 用于调试消息渲染 UI: 覆盖文本/Markdown 表格/LaTeX/SVG 电路图/
 * Mermaid 流程图/CircuitJS 电路仿真/推理块/工具卡片 等全部渲染能力。
 */

import type { ChatMessage } from '@/types'

const now = Date.now()

/** 演示对话消息 (按时间正序) */
export const DEMO_MESSAGES: ChatMessage[] = [
  // ── 1. 健康主题 (原 MOCK_MESSAGES) ──────────────
  {
    role: 'user',
    content: '简述我今天的健康状况',
    timestamp: new Date(now - 7200000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          '好的，让我为您总结今天的健康数据：\n\n## 今日概览\n\n| 指标 | 数值 | 状态 |\n|------|------|------|\n| 心率 | 69 bpm | 正常范围 |\n| 步数 | 8,421 步 | 已完成 84% |\n| 血氧 | 97% | 优秀 |\n| 睡眠 | 7h 32m | 充足 |\n\n> 整体来看，您的各项指标均在健康范围内，继续保持！',
      },
    ],
    timestamp: new Date(now - 7100000).toISOString(),
  },
  {
    role: 'user',
    content: '帮我分析一下近一周的运动趋势',
    timestamp: new Date(now - 5400000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          '## 近7日运动趋势分析\n\n过去一周您的活动量呈现上升趋势：\n\n- **周一**: 5,200 步（偏低）\n- **周二**: 6,800 步（正常）\n- **周三**: 7,100 步（正常）\n- **周四**: 9,300 步（活跃）\n- **周五**: 10,200 步（活跃）\n- **周六**: 8,400 步（正常）\n- **今日**: 8,421 步（进行中）\n\n> 建议：周三后开始明显增加，继续保持！',
      },
    ],
    timestamp: new Date(now - 5300000).toISOString(),
  },
  {
    role: 'user',
    content: '昨晚睡眠质量如何？',
    timestamp: new Date(now - 3600000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          '## 昨晚睡眠报告\n\n**总时长**: 7小时32分\n\n| 阶段 | 时长 | 占比 |\n|------|------|------|\n| 深睡 | 2h 10m | 29% |\n| REM | 1h 45m | 23% |\n| 浅睡 | 3h 05m | 41% |\n| 清醒 | 32m | 7% |\n\n深睡占比 29%（高于建议值 20%），恢复效果良好。',
      },
      {
        type: 'tool_call',
        tool: 'query_sleep_data',
        state: {
          status: 'completed',
        },
      },
    ],
    timestamp: new Date(now - 3500000).toISOString(),
  },

  // ── 2. SVG 电路图 ──────────────────────────────
  {
    role: 'user',
    content: '帮我画一个电阻分压电路图，R1=10k，R2=5k，输入5V',
    timestamp: new Date(now - 600000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          '好的，这是一个电阻分压电路：\n\n```svg\n' +
          '<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg">\n' +
          '  <!-- 电源 +5V -->\n' +
          '  <line x1="60" y1="20" x2="60" y2="45" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <text x="45" y="30" fill="#ffd166" font-size="13" font-weight="bold">+5V</text>\n' +
          '  <!-- 顶部导线 -->\n' +
          '  <line x1="60" y1="20" x2="150" y2="20" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <line x1="150" y1="20" x2="150" y2="45" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <!-- R1 电阻 (锯齿) -->\n' +
          '  <polyline points="150,45 138,60 162,75 138,90 162,105 138,120 150,135" fill="none" stroke="#a29bfe" stroke-width="2.5"/>\n' +
          '  <text x="130" y="95" fill="#a29bfe" font-size="13" font-weight="bold">R1 10k</text>\n' +
          '  <!-- 输出节点 Vout -->\n' +
          '  <line x1="150" y1="135" x2="150" y2="155" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <circle cx="150" cy="155" r="3" fill="#e8e8f0"/>\n' +
          '  <line x1="150" y1="155" x2="250" y2="155" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <circle cx="250" cy="155" r="3" fill="#e8e8f0"/>\n' +
          '  <text x="200" y="145" fill="#ff6b6b" font-size="13" font-weight="bold">Vout</text>\n' +
          '  <!-- R2 电阻 -->\n' +
          '  <polyline points="150,155 138,170 162,185 138,200 162,215 138,230 150,245" fill="none" stroke="#a29bfe" stroke-width="2.5"/>\n' +
          '  <text x="130" y="210" fill="#a29bfe" font-size="13" font-weight="bold">R2 5k</text>\n' +
          '  <!-- GND -->\n' +
          '  <line x1="150" y1="245" x2="150" y2="260" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <line x1="130" y1="260" x2="170" y2="260" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <line x1="138" y1="266" x2="162" y2="266" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <line x1="146" y1="272" x2="154" y2="272" stroke="#e8e8f0" stroke-width="2"/>\n' +
          '  <text x="126" y="285" fill="#5a5a78" font-size="11">GND</text>\n' +
          '</svg>\n```\n\n' +
          '输出电压：$V_{out} = V_{in} \\times \\dfrac{R_2}{R_1 + R_2} = 5V \\times \\dfrac{5k}{10k + 5k} = 1.67V$',
      },
    ],
    timestamp: new Date(now - 590000).toISOString(),
  },

  // ── 3. Mermaid 流程图 ──────────────────────────
  {
    role: 'user',
    content: '数据从手机采集到生成报告的流程是怎样的？画个图',
    timestamp: new Date(now - 480000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          '完整的数据流如下：\n\n```mermaid\nflowchart LR\n  A[手机传感器] --> B[采集器 Collector]\n  B --> C[HTTPS 上传]\n  C --> D[FastAPI 后端]\n  D --> E[文件存储 ai/data]\n  E --> F[fact_extractor 预处理]\n  F --> G[AI 分析子智能体]\n  G --> H{数据完整?}\n  H -->|是| I[生成报告]\n  H -->|否| F\n  I --> J[推送通知]\n```\n\n采集器每 5 分钟同步一次，AI 每 2 小时做一次数据检查。',
      },
    ],
    timestamp: new Date(now - 470000).toISOString(),
  },

  // ── 4. CircuitJS 电路仿真 ────────────────────────
  {
    role: 'user',
    content: '帮我搭一个 RC 低通滤波器电路，可以直接仿真',
    timestamp: new Date(now - 420000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          '这是一个可交互的 RC 低通滤波电路，点击可放大到完整仿真器（可编辑元件参数、切换波形）：\n\n```circuitjs\n$ 1 5.0E-6 10.20027730826997 50 5.0 50\nv 96 336 96 96 0 1 40 10 0 0 0.5\nr 96 96 320 96 0 1000\nc 320 96 320 288 0 0.0001 0\nw 320 288 96 288 0\ng 96 288 96 336 0\nO 320 96 400 96 0\nw 96 336 320 336 0\ng 96 336 96 288 0\no 1 64 0 3 10 0.05 0 2 1 3\n```\n\n1000Ω 电阻 + 100µF 电容构成低通滤波器，截止频率 $f_c = \\dfrac{1}{2\\pi RC} \\approx 1.59Hz$。',
      },
    ],
    timestamp: new Date(now - 410000).toISOString(),
  },

  // ── 5. 表格 + 引用 + 公式 ───────────────────────
  {
    role: 'user',
    content: '总结一下我今天的心率数据',
    timestamp: new Date(now - 360000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'reasoning',
        text: '分析今日心率数据: 静息 62bpm, 活动峰值 128bpm, 全天平均 78bpm, 在正常范围。',
      },
      {
        type: 'text',
        text:
          '## 今日心率概览\n\n| 时段 | 平均心率 | 状态 |\n|------|---------|------|\n| 静息 | 62 bpm | 正常 |\n| 活动 | 128 bpm | 峰值 |\n| 全天 | 78 bpm | 正常 |\n\n> [!tip] 建议\n> 全天心率稳定，继续保持规律作息。\n\n最大摄氧量估算：$VO_2 = 3.5 + 0.2 \\times HR_{reserve}$',
      },
    ],
    timestamp: new Date(now - 350000).toISOString(),
  },

  // ── 6. 工具调用卡片 ────────────────────────────
  {
    role: 'user',
    content: '查询一下最近的睡眠数据文件',
    timestamp: new Date(now - 180000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'tool_call',
        tool: 'query_sleep_data',
        state: {
          status: 'completed',
          input: { date: 'today' },
          output: '找到 3 条睡眠记录, 总时长 7h 32m',
        },
      },
      {
        type: 'text',
        text: '已查询到最近的睡眠数据：**深睡 2h10m（29%）**，恢复效果良好。',
      },
    ],
    timestamp: new Date(now - 170000).toISOString(),
  },

  // ── 7. 简单文本 ────────────────────────────────
  {
    role: 'user',
    content: '明天记得提醒我带材料力学课本',
    timestamp: new Date(now - 60000).toISOString(),
  },
  {
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: '好的，已记下。明天上午 10 点的工程力学课记得带课本和计算器。现在时间不早了，早点休息。',
      },
    ],
    timestamp: new Date(now - 50000).toISOString(),
  },
]
