/// <reference types="vite/client" />

/**
 * 旧版 WebKit 前缀的 AudioContext 构造函数
 *
 * 旧 Android WebView / Safari 仅暴露 webkitAudioContext, 标准 DOM 类型未声明该字段。
 */
interface Window {
  webkitAudioContext?: typeof AudioContext;
}
