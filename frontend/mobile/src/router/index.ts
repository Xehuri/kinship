import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteComponent, RouteRecordRaw } from 'vue-router'

interface PageRoute {
  path: string
  name: string
  view: () => Promise<RouteComponent>
}

const pageRoutes: readonly PageRoute[] = [
  { path: '/chat', name: 'chat', view: () => import('@/views/ChatView.vue') },
  { path: '/plan', name: 'plan', view: () => import('@/views/PlanView.vue') },
  { path: '/reminders', name: 'reminders', view: () => import('@/views/RemindersView.vue') },
  { path: '/reports', name: 'reports', view: () => import('@/views/ReportsView.vue') },
  { path: '/files', name: 'files', view: () => import('@/views/FilesView.vue') },
  { path: '/settings', name: 'settings', view: () => import('@/views/SettingsView.vue') },
]

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  ...pageRoutes.map<RouteRecordRaw>((page) => ({
    path: page.path,
    name: page.name,
    component: page.view,
    meta: { shell: 'v2' },
  })),
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { shell: 'v2' },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
