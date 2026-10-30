import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { bindWikiLinkHandler } from './utils/markdown'
// FontAwesome 本地打包（取代 cdnjs 外链，消除渲染阻塞的外部依赖；图标数仅取所用子集）
import '@fortawesome/fontawesome-free/css/all.min.css'
import './styles/main.css'
import './styles/code-surface.css'

// 注册 wiki-link 全局点击委托 (CSP 友好, 取代内联 onclick; FE-L3)
bindWikiLinkHandler()

// Initialize theme immediately (before any render) to prevent flash of wrong colors
const initialTheme = localStorage.getItem('theme') as 'dark' | 'light' | 'glacier' | null
if (initialTheme && ['dark', 'light', 'glacier'].includes(initialTheme)) {
  document.documentElement.setAttribute('data-theme', initialTheme)
} else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
  document.documentElement.setAttribute('data-theme', 'light')
} else {
  document.documentElement.setAttribute('data-theme', 'dark')
}

// 顶部页边距同样在挂载前应用, 避免首屏渲染出旧位置后跳动
// (完整状态与校验逻辑见 composables/useTopInset.ts)
const initialTopInset = Number(localStorage.getItem('top_inset'))
if (Number.isFinite(initialTopInset) && initialTopInset > 0) {
  document.documentElement.style.setProperty('--user-top-inset', `${initialTopInset}px`)
}

const app = createApp(App)
app.use(router)
app.mount('#app')
