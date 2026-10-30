<script setup lang="ts">
import { computed } from 'vue'
import {
  KeyRound,
  LockKeyhole,
  Monitor,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from 'lucide-vue-next'
import type { SensorFormState } from '../lib/sensor-form'
import ToggleSwitch from './ToggleSwitch.vue'

const props = defineProps<{
  form: SensorFormState
  serverUrl: string
}>()

const idleError = computed(() => {
  const value = Number(props.form.idleThreshold)
  if (!Number.isFinite(value) || value < 30 || value > 3600) {
    return '无人判定阈值需在 30-3600 秒之间'
  }
  return ''
})
</script>

<template>
  <div class="sensor-form">
    <div class="switch-row switch-row--lead">
      <div class="switch-row__text">
        <strong>启用 PC 采集端</strong>
        <small>采集前台窗口、空闲与锁屏状态，并上报到服务器。</small>
      </div>
      <ToggleSwitch v-model="form.enabled" label="启用 PC 采集端" />
    </div>

    <div class="form-grid">
      <div class="field field--full">
        <label class="field__label" for="scf-server-url">服务器地址</label>
        <input
          id="scf-server-url"
          class="input mono"
          :value="serverUrl || '尚未设置服务器地址'"
          readonly
          aria-readonly="true"
        />
        <p class="field__hint">与服务器连接地址保持一致，保存后采集端会使用该地址上报。</p>
      </div>

      <div class="field">
        <label class="field__label" for="scf-agent-id">设备 ID</label>
        <input
          id="scf-agent-id"
          data-test="agent-id"
          v-model="form.agentId"
          class="input mono"
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="field__hint">用于区分不同电脑，保持唯一即可。</p>
      </div>

      <div class="field">
        <label class="field__label" for="scf-agent-name">设备名称</label>
        <input
          id="scf-agent-name"
          data-test="agent-name"
          v-model="form.agentName"
          class="input"
          maxlength="64"
          autocomplete="off"
        />
        <p class="field__hint">显示在服务器与报表中的电脑名称。</p>
      </div>
    </div>

    <div class="field">
      <span class="field__label">认证方式</span>
      <div class="segmented" role="radiogroup" aria-label="认证方式">
        <button
          type="button"
          role="radio"
          data-test="auth-credentials"
          :aria-checked="form.authMode === 'credentials'"
          @click="form.authMode = 'credentials'"
        >
          账号密码
        </button>
        <button
          type="button"
          role="radio"
          data-test="auth-token"
          :aria-checked="form.authMode === 'token'"
          @click="form.authMode = 'token'"
        >
          访问令牌
        </button>
      </div>
    </div>

    <div v-if="form.authMode === 'credentials'" class="form-grid">
      <div class="field">
        <label class="field__label" for="scf-username">用户名</label>
        <input
          id="scf-username"
          data-test="sensor-username"
          v-model="form.username"
          class="input"
          autocomplete="username"
          spellcheck="false"
        />
      </div>

      <div class="field">
        <label class="field__label" for="scf-password">
          <LockKeyhole :size="13" :stroke-width="2" />
          密码
        </label>
        <input
          id="scf-password"
          data-test="sensor-password"
          v-model="form.password"
          class="input"
          type="password"
          placeholder="留空则不修改"
          autocomplete="new-password"
        />
        <p v-if="form.hasStoredPassword" class="field__note">
          <ShieldCheck :size="13" :stroke-width="2" />
          已用 Windows DPAPI 加密保存
        </p>
      </div>

      <div class="field field--full">
        <label class="check-row">
          <input type="checkbox" v-model="form.rememberPassword" />
          记住密码（使用 Windows DPAPI 加密）
        </label>
      </div>
    </div>

    <div v-else class="field">
      <label class="field__label" for="scf-token">
        <KeyRound :size="13" :stroke-width="2" />
        后端访问令牌
      </label>
      <input
        id="scf-token"
        data-test="sensor-token"
        v-model="form.backendToken"
        class="input"
        type="password"
        :placeholder="form.hasBackendToken ? '已配置，留空则不修改' : '粘贴后端访问令牌'"
        autocomplete="off"
      />
      <p class="field__hint">用于 PC 采集端调用后端接口；留空表示保持现有令牌。</p>
    </div>

    <div class="form-grid">
      <div class="field">
        <label class="field__label" for="scf-idle-threshold">
          <Timer :size="13" :stroke-width="2" />
          无人判定阈值
        </label>
        <div class="input-suffix">
          <input
            id="scf-idle-threshold"
            data-test="idle-threshold"
            v-model.number="form.idleThreshold"
            class="input"
            type="number"
            min="30"
            max="3600"
            step="10"
            :class="{ 'input--invalid': idleError.length > 0 }"
            :aria-invalid="idleError.length > 0"
          />
          <span>秒</span>
        </div>
        <p v-if="idleError" class="field__error">{{ idleError }}</p>
        <p v-else class="field__hint">连续无操作超过该时长判定为无人，范围 30-3600 秒。</p>
      </div>
    </div>

    <div class="toggle-group">
      <div class="switch-row">
        <div class="switch-row__text">
          <strong>前台窗口</strong>
          <small>记录当前前台应用与窗口标题。</small>
        </div>
        <ToggleSwitch v-model="form.windowEnabled" label="前台窗口采集" />
      </div>
      <div class="switch-row">
        <div class="switch-row__text">
          <strong>空闲状态</strong>
          <small>根据键鼠活动判断无人使用状态。</small>
        </div>
        <ToggleSwitch v-model="form.idleEnabled" label="空闲状态采集" />
      </div>
      <div class="switch-row">
        <div class="switch-row__text">
          <strong>锁屏状态</strong>
          <small>记录屏幕锁定与解锁事件。</small>
        </div>
        <ToggleSwitch v-model="form.screenEnabled" label="锁屏状态采集" />
      </div>
    </div>

    <div class="divider" />

    <div class="switch-row">
      <div class="switch-row__text">
        <strong>
          <Monitor :size="13" :stroke-width="2" />
          校验服务器证书
        </strong>
        <small>默认开启。关闭后不会校验 TLS 证书，仅在你信任该服务器时关闭。</small>
      </div>
      <ToggleSwitch v-model="form.sslVerify" label="校验服务器证书" />
    </div>

    <div v-if="!form.sslVerify" class="notice notice--warning" role="alert">
      <TriangleAlert :size="16" :stroke-width="2" />
      <div>
        <strong>证书校验已关闭</strong>
        仅在你信任该服务器时关闭，否则可能遭受中间人攻击。
      </div>
    </div>

    <div v-if="$slots.actions" class="sensor-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.sensor-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.switch-row--lead {
  padding-top: 0;
}

.field__note {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: var(--success-ink);
  font-size: var(--text-xs);
}

.switch-row__text strong {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.toggle-group {
  padding: 2px 0;
}

.sensor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2);
}
</style>
