<template>
  <Teleport to="body">
    <Transition name="detail-overlay">
      <div
        v-if="visible"
        class="detail-overlay"
        :class="{ open: visible }"
        @keydown.escape="handleClose"
        tabindex="-1"
        ref="overlayRef"
      >
        <!-- 头部 -->
        <div class="detail-header">
          <span class="dt-title">{{ title }}</span>
          <button class="dt-close" @click="handleClose" aria-label="关闭">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- 内容区域 -->
        <div class="detail-body">
          <!-- 日期导航栏 -->
          <div class="dt-datebar" v-if="showDateNav">
            <button class="dt-nav" @click="$emit('date-change', -1)" aria-label="上一天">
              <i class="fas fa-chevron-left"></i>
            </button>
            <span class="dt-date">{{ currentDate }}</span>
            <button class="dt-nav" @click="$emit('date-change', 1)" aria-label="下一天">
              <i class="fas fa-chevron-right"></i>
            </button>
          </div>

          <!-- 统计网格 -->
          <div class="dt-stat-grid" v-if="$slots.stats || stats.length">
            <slot name="stats">
              <div
                v-for="(stat, index) in stats"
                :key="index"
                class="dt-stat"
              >
                <div class="dt-sval" :style="{ color: stat.color || 'var(--text)' }">
                  {{ stat.value }}
                </div>
                <div class="dt-slabel">{{ stat.label }}</div>
              </div>
            </slot>
          </div>

          <!-- 图表区域 -->
          <div class="dt-detail-chart" v-if="$slots.chart">
            <slot name="chart"></slot>
          </div>

          <!-- 洞察区域 -->
          <div class="dt-insight" v-if="$slots.insight || insight">
            <slot name="insight">
              {{ insight }}
            </slot>
          </div>

          <!-- 默认插槽 -->
          <slot></slot>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'

interface StatItem {
  value: string | number
  label: string
  color?: string
}

const props = withDefaults(defineProps<{
  title: string
  visible: boolean
  currentDate?: string
  showDateNav?: boolean
  stats?: StatItem[]
  insight?: string
}>(), {
  currentDate: '',
  showDateNav: false,
  stats: () => [],
  insight: ''
})

const emit = defineEmits<{
  close: []
  'date-change': [direction: number]
}>()

const overlayRef = ref<HTMLElement | null>(null)

// 处理关闭
function handleClose() {
  emit('close')
}

// 处理ESC键
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.visible) {
    handleClose()
  }
}

// 监听visible变化，自动聚焦以捕获键盘事件
watch(() => props.visible, async (newVal) => {
  if (newVal) {
    await nextTick()
    overlayRef.value?.focus()
  }
})

// 生命周期钩子
onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.detail-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  /* 跟随主题的遮罩色 (与 NotificationsDrawer 保持一致):
     硬编码 rgba(0,0,0,.88) 会让浅色/冰川主题下的 .detail-body 变成深色底, 正文不可读 */
  background: var(--overlay-bg, rgba(0, 0, 0, 0.88));
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  display: flex;
  flex-direction: column;
  z-index: 700;
  outline: none;
}

/* 过渡动画 */
.detail-overlay-enter-active,
.detail-overlay-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.detail-overlay-enter-from,
.detail-overlay-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

/* 头部 */
.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  /* 顶部让出 --app-top-inset, 避免标题/关闭按钮被手机状态栏遮挡 */
  padding: calc(14px + var(--app-top-inset, 0px)) 20px 14px;
  flex-shrink: 0;
  background: var(--surface);
}

.dt-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.dt-close {
  background: transparent;
  border: none;
  color: var(--text3);
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.15s;
}

.dt-close:hover {
  background: var(--surface2);
}

.dt-close:active {
  background: var(--surface3);
}

/* 内容区域 */
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 20px 90px;
  -webkit-overflow-scrolling: touch;
}

/* 日期导航栏 */
.dt-datebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  background: var(--surface);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
}

.dt-nav {
  font-size: 16px;
  cursor: pointer;
  color: var(--text3);
  padding: 2px 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
}

.dt-nav:hover {
  background: var(--surface2);
  color: var(--text);
}

.dt-nav:active {
  background: var(--surface3);
}

.dt-date {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

/* 统计网格 */
.dt-stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 14px;
}

.dt-stat {
  background: var(--surface2);
  border-radius: var(--radius-sm);
  padding: 10px;
  text-align: center;
}

.dt-sval {
  font-size: 20px;
  font-weight: 700;
  font-family: 'Plus Jakarta Sans', sans-serif;
  color: var(--text);
}

.dt-slabel {
  font-size: 10px;
  color: var(--text3);
  margin-top: 2px;
}

/* 图表区域 */
.dt-detail-chart {
  height: 200px;
  background: var(--surface2);
  border-radius: var(--radius-sm);
  padding: 8px;
  margin-bottom: 12px;
}

/* 洞察区域 */
.dt-insight {
  background: var(--surface2);
  border-radius: var(--radius-sm);
  padding: 12px;
  font-size: 12px;
  color: var(--text2);
  line-height: 1.6;
}
</style>
