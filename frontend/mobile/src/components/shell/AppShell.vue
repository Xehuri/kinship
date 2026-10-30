<template>
  <div
    class="ax-shell"
    :class="{
      'ax-shell--inspector-open': inspectorOpen,
      'ax-shell--no-inspector': !$slots.inspector,
    }"
    :data-layout="isMobile ? 'mobile' : 'desktop'"
  >
    <SideNav
      class="ax-shell__nav"
      :items="NAV_V2_DESKTOP"
      :active="activeNav"
      :aria-hidden="isMobile ? 'true' : undefined"
      @select="navigate"
    />

    <div class="ax-shell__main">
      <header class="ax-shell__header">
        <PageHeader :title="title" :meta="meta">
          <template #actions>
            <slot name="actions" />
            <button
              v-if="$slots.inspector && !isMobile"
              class="ax-shell__inspector-trigger"
              type="button"
              data-testid="inspector-trigger"
              aria-label="打开上下文"
              :aria-expanded="inspectorOpen ? 'true' : 'false'"
              :title="inspectorOpen ? '关闭上下文' : '打开上下文'"
              @click="toggleInspector"
            >
              <AppIcon name="SidebarSimple" :size="18" />
            </button>
            <button
              class="ax-shell__notification"
              type="button"
              data-testid="notifications-trigger"
              aria-label="通知历史"
              title="通知历史"
              @click="openNotifications"
            >
              <AppIcon name="Bell" :size="17" />
            </button>
          </template>
        </PageHeader>
      </header>
      <div class="ax-shell__body">
        <slot />
      </div>
    </div>

    <aside
      class="ax-shell__inspector"
      data-testid="inspector-slot"
      aria-label="上下文"
    >
      <button
        v-if="$slots.inspector"
        class="ax-shell__inspector-close"
        type="button"
        data-testid="inspector-close"
        aria-label="关闭上下文"
        @click="closeInspector"
      >
        <AppIcon name="X" :size="16" />
      </button>
      <slot name="inspector" />
    </aside>

    <MobileNav
      class="ax-shell__mobile-nav"
      :items="NAV_V2_MOBILE"
      :active="activeMobileNav"
      :aria-hidden="isMobile ? undefined : 'true'"
      @select="navigateMobile"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import MobileNav from './MobileNav.vue'
import PageHeader from './PageHeader.vue'
import SideNav from './SideNav.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useNotificationsSingleton } from '@/composables/useNotifications'
import {
  NAV_V2_DESKTOP,
  NAV_V2_MOBILE,
  type MobileNavV2Id,
  type NavV2Id,
} from '@/config/navV2'

const props = withDefaults(
  defineProps<{
    title: string
    meta?: string
    inspectorOpen?: boolean
  }>(),
  {
    meta: '',
    inspectorOpen: false,
  },
)

const emit = defineEmits<{ 'update:inspectorOpen': [open: boolean] }>()

const route = useRoute()
const router = useRouter()
const isMobile = useMediaQuery('(max-width: 767.98px)')
const notifications = useNotificationsSingleton()

function openNotifications(): void {
  void notifications.open()
}

function toggleInspector(): void {
  emit('update:inspectorOpen', !props.inspectorOpen)
}

function closeInspector(): void {
  emit('update:inspectorOpen', false)
}

const activeNav = computed<NavV2Id | null>(() => {
  return NAV_V2_DESKTOP.find((item) => item.route === route.path)?.id ?? null
})

const activeMobileNav = computed<MobileNavV2Id | null>(() => {
  return NAV_V2_MOBILE.find((item) => item.route === route.path)?.id ?? null
})

function navigate(id: NavV2Id): void {
  const item = NAV_V2_DESKTOP.find((entry) => entry.id === id)
  if (item && item.route !== route.path) {
    void router.push(item.route)
  }
}

function navigateMobile(id: MobileNavV2Id): void {
  const item = NAV_V2_MOBILE.find((entry) => entry.id === id)
  if (item && item.route !== route.path) {
    void router.push(item.route)
  }
}
</script>
