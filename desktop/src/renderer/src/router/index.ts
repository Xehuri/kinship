import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router, RouterHistory, RouteRecordRaw } from 'vue-router'
import SetupView from '../views/SetupView.vue'
import SettingsView from '../views/SettingsView.vue'
import ErrorView from '../views/ErrorView.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/settings' },
  {
    path: '/setup',
    name: 'setup',
    component: SetupView,
    meta: { title: '初始化' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsView,
    meta: { title: '设置' },
  },
  {
    path: '/error',
    name: 'error',
    component: ErrorView,
    meta: { title: '连接问题' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/settings' },
]

export function createAppRouter(history: RouterHistory = createWebHashHistory()): Router {
  const router = createRouter({
    history,
    routes,
    scrollBehavior: () => ({ top: 0 }),
  })

  router.afterEach((to) => {
    const title = typeof to.meta.title === 'string' ? to.meta.title : ''
    document.title = title ? `${title} · Kinship` : 'Kinship'
  })

  return router
}

export const router = createAppRouter()
