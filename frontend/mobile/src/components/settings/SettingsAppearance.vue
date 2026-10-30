<template>
  <SettingsSection title="外观" description="主题、强调色、密度与动效">
    <div class="settings-controls">
      <div class="settings-field" data-setting-row="theme">
        <div class="settings-field__label">
          <span class="settings-row__icon">
            <AppIcon name="Sun" :size="18" />
          </span>
          <span class="settings-row__text">
            <span class="settings-row__title">主题</span>
            <span class="settings-row__hint">
              当前生效：{{ resolvedTheme === 'dark' ? '深色' : '浅色' }}<span class="settings-nowrap">（跟随系统时随系统切换）</span>
            </span>
          </span>
        </div>
        <div class="settings-field__control">
          <div class="settings-segmented settings-segmented--3" role="group" aria-label="主题">
            <button
              v-for="option in THEME_OPTIONS"
              :key="option.value"
              class="settings-segmented__option"
              type="button"
              data-setting="theme"
              :data-value="option.value"
              :aria-pressed="theme === option.value"
              @click="setTheme(option.value)"
            >
              <AppIcon :name="option.icon" :size="14" />
              <span>{{ option.label }}</span>
              <span v-if="theme === option.value" class="settings-segmented__check">
                <AppIcon name="Check" :size="12" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-field" data-setting-row="accent">
        <div class="settings-field__label">
          <span class="settings-row__icon">
            <AppIcon name="Palette" :size="18" />
          </span>
          <span class="settings-row__text">
            <span class="settings-row__title">强调色</span>
            <span class="settings-row__hint">按钮、选中态与图表高亮使用的颜色</span>
          </span>
        </div>
        <div class="settings-field__control">
          <div class="settings-segmented settings-segmented--4" role="group" aria-label="强调色">
            <button
              v-for="option in ACCENT_OPTIONS"
              :key="option.value"
              class="settings-accent-option"
              type="button"
              data-setting="accent"
              :data-value="option.value"
              :aria-pressed="accent === option.value"
              @click="setAccent(option.value)"
            >
              <span
                class="settings-accent-dot"
                :class="`settings-accent-dot--${option.value}`"
                aria-hidden="true"
              />
              <span class="settings-accent-label">{{ option.label }}</span>
              <span v-if="accent === option.value" class="settings-segmented__check">
                <AppIcon name="Check" :size="12" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-field" data-setting-row="density">
        <div class="settings-field__label">
          <span class="settings-row__icon">
            <AppIcon name="SlidersHorizontal" :size="18" />
          </span>
          <span class="settings-row__text">
            <span class="settings-row__title">信息密度</span>
            <span class="settings-row__hint">紧凑模式收紧行距，不缩小触控区域</span>
          </span>
        </div>
        <div class="settings-field__control">
          <div class="settings-segmented settings-segmented--2" role="group" aria-label="信息密度">
            <button
              v-for="option in DENSITY_OPTIONS"
              :key="option.value"
              class="settings-segmented__option"
              type="button"
              data-setting="density"
              :data-value="option.value"
              :aria-pressed="density === option.value"
              @click="setDensity(option.value)"
            >
              <span>{{ option.label }}</span>
              <span v-if="density === option.value" class="settings-segmented__check">
                <AppIcon name="Check" :size="12" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-field" data-setting-row="motion">
        <div class="settings-field__label">
          <span class="settings-row__icon">
            <AppIcon name="Lightning" :size="18" />
          </span>
          <span class="settings-row__text">
            <span class="settings-row__title">动效</span>
            <span class="settings-row__hint">减弱模式会压缩过渡与动画时长</span>
          </span>
        </div>
        <div class="settings-field__control">
          <div class="settings-segmented settings-segmented--2" role="group" aria-label="动效">
            <button
              v-for="option in MOTION_OPTIONS"
              :key="option.value"
              class="settings-segmented__option"
              type="button"
              data-setting="motion"
              :data-value="option.value"
              :aria-pressed="motion === option.value"
              @click="setMotion(option.value)"
            >
              <span>{{ option.label }}</span>
              <span v-if="motion === option.value" class="settings-segmented__check">
                <AppIcon name="Check" :size="12" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-field settings-field--wide" data-setting-row="top-inset">
        <div class="settings-field__label">
          <span class="settings-row__icon">
            <AppIcon name="Monitor" :size="18" />
          </span>
          <span class="settings-row__text">
            <span class="settings-row__title">顶部页边距</span>
            <span class="settings-row__hint">避让手机状态栏；仅移动端生效</span>
          </span>
          <span class="settings-row__value">{{ topInset }} px</span>
        </div>
        <div class="settings-range-row">
          <input
            class="settings-range top-inset-range"
            type="range"
            :min="TOP_INSET_MIN"
            :max="TOP_INSET_MAX"
            :step="TOP_INSET_STEP"
            :value="topInset"
            aria-label="顶部页边距"
            @input="handleTopInsetInput"
          />
          <button class="settings-button settings-button--compact top-inset-reset-btn" type="button" @click="resetTopInset">
            重置
          </button>
        </div>
      </div>
    </div>
  </SettingsSection>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import {
  useTheme,
  type AccentName,
  type DensityName,
  type MotionName,
  type ThemeName,
} from '@/composables/useTheme'
import { useTopInset } from '@/composables/useTopInset'

const {
  theme,
  resolvedTheme,
  accent,
  density,
  motion,
  setTheme,
  setAccent,
  setDensity,
  setMotion,
} = useTheme()

const {
  topInset,
  setTopInset,
  resetTopInset,
  TOP_INSET_MIN,
  TOP_INSET_MAX,
  TOP_INSET_STEP,
} = useTopInset()

interface ThemeOption {
  value: ThemeName
  label: string
  icon: string
}

interface PreferenceOption<T> {
  value: T
  label: string
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'light', label: '浅色', icon: 'Sun' },
  { value: 'dark', label: '深色', icon: 'Moon' },
  { value: 'system', label: '跟随系统', icon: 'Monitor' },
]

const ACCENT_OPTIONS: readonly PreferenceOption<AccentName>[] = [
  { value: 'ochre', label: '赭石' },
  { value: 'jade', label: '青玉' },
  { value: 'indigo', label: '靛蓝' },
  { value: 'rose', label: '玫瑰' },
]

const DENSITY_OPTIONS: readonly PreferenceOption<DensityName>[] = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
]

const MOTION_OPTIONS: readonly PreferenceOption<MotionName>[] = [
  { value: 'full', label: '标准' },
  { value: 'reduced', label: '减弱' },
]

function handleTopInsetInput(event: Event): void {
  const target = event.target as HTMLInputElement
  setTopInset(Number(target.value))
}
</script>
