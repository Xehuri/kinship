<template>
  <div class="skeleton-msgs">
    <!-- 骨架气泡：交替用户/AI -->
    <div class="sk-msg sk-user">
      <div class="sk-bubble sk-bubble-user"></div>
    </div>
    <div class="sk-msg sk-ai">
      <div class="sk-bubble sk-bubble-ai sk-line-short"></div>
    </div>
    <div class="sk-msg sk-user">
      <div class="sk-bubble sk-bubble-user sk-line-long"></div>
    </div>
    <div class="sk-msg sk-ai">
      <div class="sk-bubble sk-bubble-ai sk-line-short"></div>
      <div class="sk-bubble sk-bubble-ai sk-line-med"></div>
      <div class="sk-bubble sk-bubble-ai sk-line-long"></div>
    </div>
    <div class="sk-msg sk-user">
      <div class="sk-bubble sk-bubble-user sk-line-long"></div>
    </div>
    <div class="sk-msg sk-ai">
      <div class="sk-bubble sk-bubble-ai sk-line-short"></div>
    </div>
  </div>
</template>

<style scoped>
.skeleton-msgs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
}

.sk-msg {
  display: flex;
}

.sk-user {
  justify-content: flex-end;
}

.sk-ai {
  justify-content: flex-start;
}

.sk-bubble {
  height: 32px;
  border-radius: 18px;
  background: linear-gradient(90deg, var(--surface2) 25%, var(--surface3) 50%, var(--surface2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

.sk-bubble-user {
  width: 60%;
  background: linear-gradient(90deg, rgba(10,132,255,0.3) 25%, rgba(10,132,255,0.5) 50%, rgba(10,132,255,0.3) 75%);
  background-size: 200% 100%;
}

.sk-bubble-ai {
  background: linear-gradient(90deg, var(--surface2) 25%, var(--surface3) 50%, var(--surface2) 75%);
  background-size: 200% 100%;
}

.sk-line-short {
  width: 35%;
}

.sk-line-med {
  width: 55%;
}

.sk-line-long {
  width: 75%;
}

/* 多条 AI 气泡连续显示，模拟真实聊天样式 */
.sk-ai .sk-bubble + .sk-bubble {
  margin-top: 4px;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
