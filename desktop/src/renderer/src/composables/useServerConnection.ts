import { computed, readonly, ref } from 'vue'
import type { CertInfo, ServerTestResult } from '../../../shared/types'
import { certificateCaPem } from '../lib/cert'
import { useDesktopApi } from './useDesktopApi'

export interface ConnectionFailure {
  message: string
  code?: string
}

export function useServerConnection() {
  const api = useDesktopApi()
  const testing = ref(false)
  const trusting = ref(false)
  const result = ref<ServerTestResult | null>(null)
  const failure = ref<ConnectionFailure | null>(null)
  const cert = ref<CertInfo | null>(null)
  const trustedCert = ref<CertInfo | null>(null)
  const trustError = ref<string | null>(null)
  const hardBlocked = ref(false)

  const caPem = computed(() => certificateCaPem(cert.value))
  const caPemAvailable = computed(() => caPem.value !== undefined)
  const showTrustPanel = computed(
    () => cert.value !== null && failure.value?.code === 'CERT_UNTRUSTED',
  )
  const failed = computed(
    () => failure.value !== null || (result.value !== null && !result.value.ok),
  )

  function reset(): void {
    testing.value = false
    trusting.value = false
    result.value = null
    failure.value = null
    cert.value = null
    trustedCert.value = null
    trustError.value = null
    hardBlocked.value = false
  }

  async function test(url: string): Promise<boolean> {
    testing.value = true
    result.value = null
    failure.value = null
    cert.value = null
    trustError.value = null
    hardBlocked.value = false

    const response = await api.testServer(url)
    testing.value = false

    if (!response.ok) {
      failure.value = {
        message: response.error || '测试连接失败',
        code: response.code,
      }
      return false
    }

    const data = response.data
    if (data.ok) {
      result.value = data
      return true
    }

    failure.value = {
      message: data.error || '连接测试未通过',
      code: data.code,
    }
    if (data.code === 'CERT_UNTRUSTED' && data.cert) {
      cert.value = data.cert
    }
    if (data.code === 'CERT_INVALID') {
      hardBlocked.value = true
    }
    return false
  }

  async function trust(): Promise<boolean> {
    const current = cert.value
    const pem = caPem.value
    if (!current || !pem) return false

    trusting.value = true
    trustError.value = null
    const response = await api.trustCertificate({
      host: current.host,
      port: current.port,
      caPem: pem,
    })
    trusting.value = false

    if (!response.ok) {
      trustError.value = response.error || '证书信任失败'
      return false
    }

    trustedCert.value = response.data ?? current
    result.value = { ok: true }
    failure.value = null
    cert.value = null
    hardBlocked.value = false
    return true
  }

  return {
    testing: readonly(testing),
    trusting: readonly(trusting),
    result: readonly(result),
    failure: readonly(failure),
    cert: readonly(cert),
    trustedCert: readonly(trustedCert),
    trustError: readonly(trustError),
    hardBlocked: readonly(hardBlocked),
    caPemAvailable,
    showTrustPanel,
    failed,
    reset,
    test,
    trust,
  }
}
