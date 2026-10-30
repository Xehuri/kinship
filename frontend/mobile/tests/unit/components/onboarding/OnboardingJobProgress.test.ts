/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import OnboardingJobProgress from '@/components/onboarding/OnboardingJobProgress.vue'
import type { DownloadJob } from '@/api/system'

enableAutoUnmount(afterEach)

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-1',
    kind: 'download:kernel',
    state: 'running',
    asset: 'kernel',
    progress: { bytes: 420, total: 1000, pct: 42 },
    current: 'kernel',
    logs_tail: [],
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-10-29T00:00:00Z',
    updated_at: '2026-10-29T00:00:01Z',
    ...overrides,
  }
}

describe('OnboardingJobProgress', () => {
  it('tells the user the page can be closed while the job keeps running', () => {
    const wrapper = mount(OnboardingJobProgress, { props: { job: makeJob() } })

    expect(wrapper.get('[data-onboarding-job-leave-note]').text()).toContain(
      '可关闭页面，任务会继续；重新打开可继续查看',
    )
    expect(wrapper.get('[data-onboarding-job-progress-text]').text()).toContain('42%')
  })

  it('hides the leave note after the job reaches a terminal state', () => {
    const wrapper = mount(OnboardingJobProgress, {
      props: { job: makeJob({ state: 'done', progress: { bytes: 1000, total: 1000, pct: 100 } }) },
    })

    expect(wrapper.find('[data-onboarding-job-leave-note]').exists()).toBe(false)
  })
})
