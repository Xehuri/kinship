<template>
  <AppShell title="设置" meta="偏好与系统">
    <div class="ax-page settings-page">
      <section
        class="settings-group settings-group--account"
        aria-labelledby="settings-group-account"
      >
        <h2 id="settings-group-account" class="settings-group__label">账户与偏好</h2>
        <div class="settings-group__grid">
          <SettingsAccount />
          <SettingsAppearance />
        </div>
      </section>

      <section
        class="settings-group settings-group--data"
        aria-labelledby="settings-group-data"
      >
        <h2 id="settings-group-data" class="settings-group__label">数据与连接</h2>
        <div class="settings-group__grid">
          <SettingsHealth />
          <SettingsSources />
          <SettingsDevice />
        </div>
      </section>

      <section
        class="settings-group settings-group--system"
        aria-labelledby="settings-group-system"
      >
        <h2 id="settings-group-system" class="settings-group__label">系统与关于</h2>
        <div class="settings-group__grid">
          <SettingsDebug />
          <SettingsAbout />
          <SettingsSystemConfig @open-onboarding="onboardingOpen = true" />
          <ServicesPanel />
        </div>
      </section>
    </div>

    <OnboardingWizard
      :visible="onboardingOpen"
      test-mode
      @close="onboardingOpen = false"
      @completed="onWizardCompleted"
    />
  </AppShell>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import OnboardingWizard from '@/components/onboarding/OnboardingWizard.vue'
import SettingsAccount from '@/components/settings/SettingsAccount.vue'
import SettingsAppearance from '@/components/settings/SettingsAppearance.vue'
import SettingsAbout from '@/components/settings/SettingsAbout.vue'
import SettingsDebug from '@/components/settings/SettingsDebug.vue'
import SettingsDevice from '@/components/settings/SettingsDevice.vue'
import SettingsHealth from '@/components/settings/SettingsHealth.vue'
import SettingsSources from '@/components/settings/SettingsSources.vue'
import SettingsSystemConfig from '@/components/settings/SettingsSystemConfig.vue'
import ServicesPanel from '@/components/settings/ServicesPanel.vue'
import { useSetupStatus } from '@/composables/useSetupStatus'
import '@/components/settings/settings.css'

const { refreshSetupStatus } = useSetupStatus()

/** 测试模式向导是否打开 (设置页入口, 不参与 App 自动首启) */
const onboardingOpen = ref(false)

/** 向导完成: 收起并刷新初始化状态, 不重载页面 */
async function onWizardCompleted(): Promise<void> {
  onboardingOpen.value = false
  await refreshSetupStatus()
}
</script>
