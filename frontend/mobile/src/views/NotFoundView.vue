<template>
  <AppShell title="未找到页面" meta="404">
    <div class="ax-page">
      <div class="ax-state">
        <h2 class="ax-state__title">这个地址没有内容</h2>
        <p class="ax-state__body">检查链接，或回到对话继续。</p>
        <RouterLink class="ax-state__action" to="/chat">
          回到对话
        </RouterLink>
      </div>
    </div>
  </AppShell>
</template>

<script setup lang="ts">
import AppShell from '@/components/shell/AppShell.vue'
</script>
