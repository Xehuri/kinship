<template>
  <div class="ax-composer" data-testid="composer">
    <div v-if="selectedFiles.length > 0" class="ax-composer__files">
      <span
        v-for="(file, index) in selectedFiles"
        :key="`${file.name}:${file.lastModified}:${index}`"
        class="ax-composer__file"
      >
        <img
          v-if="isImage(file)"
          :src="getPreviewUrl(file)"
          class="ax-composer__thumb"
          alt=""
        />
        <AppIcon v-else name="Paperclip" :size="12" />
        <span class="ax-composer__file-name">{{ file.name }}</span>
        <button
          class="ax-composer__file-remove"
          type="button"
          :aria-label="`移除文件：${file.name}`"
          @click="removeFile(index)"
        >
          <AppIcon name="X" :size="12" />
        </button>
      </span>
    </div>

    <div class="ax-composer__row">
      <button
        class="ax-composer__attach"
        type="button"
        data-testid="composer-file"
        aria-label="添加文件"
        title="添加文件"
        @click="openFilePicker"
      >
        <AppIcon name="Paperclip" :size="18" />
      </button>
      <input
        ref="fileInputRef"
        class="ax-composer__file-input"
        type="file"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="handleFilesSelected"
      />

      <textarea
        ref="inputRef"
        v-model="messageText"
        class="ax-composer__input"
        data-testid="composer-input"
        rows="1"
        placeholder="输入消息…"
        aria-label="消息输入"
        @keydown="handleKeydown"
        @input="autoResize"
        @paste="handlePaste"
      />

      <button
        class="ax-composer__send"
        type="button"
        data-testid="composer-send"
        aria-label="发送消息"
        :disabled="!canSend"
        @click="handleSend"
      >
        <AppIcon name="ArrowUp" :size="18" weight="bold" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

const emit = defineEmits<{
  send: [text: string, files: File[]]
}>()

const inputRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const messageText = ref('')
const selectedFiles = ref<File[]>([])

const canSend = computed(
  () => messageText.value.trim().length > 0 || selectedFiles.value.length > 0,
)

/** 同一 File 只创建一次 objectURL, 避免渲染重复创建造成泄漏 */
const previewUrls = new Map<File, string>()

function isImage(file: File): boolean {
  return file.type.startsWith('image/')
}

function getPreviewUrl(file: File): string {
  let url = previewUrls.get(file)
  if (!url) {
    url = URL.createObjectURL(file)
    previewUrls.set(file, url)
  }
  return url
}

function revokeFileUrl(file: File): void {
  const url = previewUrls.get(file)
  if (!url) return
  URL.revokeObjectURL(url)
  previewUrls.delete(file)
}

function revokeAllFileUrls(): void {
  previewUrls.forEach((url) => URL.revokeObjectURL(url))
  previewUrls.clear()
}

function openFilePicker(): void {
  fileInputRef.value?.click()
}

function handleFilesSelected(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (files) {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (file) selectedFiles.value.push(file)
    }
  }
  input.value = ''
}

function removeFile(index: number): void {
  const file = selectedFiles.value[index]
  if (file) revokeFileUrl(file)
  selectedFiles.value.splice(index, 1)
}

function clearFiles(): void {
  selectedFiles.value = []
  revokeAllFileUrls()
}

function handlePaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.items
  if (!items) return

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    const extension = item.type.split('/')[1] || 'png'
    selectedFiles.value.push(
      new File([file], `粘贴图片_${Date.now()}.${extension}`, { type: item.type }),
    )
  }
}

function autoResize(): void {
  void nextTick(() => {
    const el = inputRef.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  })
}

function handleKeydown(event: KeyboardEvent): void {
  // 中文/日文输入法组合中回车用于选词, 不触发发送
  if (event.isComposing || event.keyCode === 229) {
    autoResize()
    return
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
    return
  }

  autoResize()
}

function handleSend(): void {
  if (!canSend.value) return

  emit('send', messageText.value.trim(), [...selectedFiles.value])
  messageText.value = ''
  clearFiles()
  void nextTick(() => {
    const el = inputRef.value
    if (el) el.style.height = 'auto'
  })
}

onMounted(() => {
  inputRef.value?.focus()
})

onBeforeUnmount(() => {
  revokeAllFileUrls()
})
</script>

<style scoped>
.ax-composer {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-2);
  inline-size: 100%;
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-block-start: 1px solid var(--hairline);
  background: var(--surface);
}

.ax-composer__files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  max-inline-size: var(--chat-column);
  margin-inline: auto;
  inline-size: 100%;
}

.ax-composer__file {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-inline-size: 100%;
  min-block-size: 32px;
  padding: 2px var(--space-2) 2px 4px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--inset);
  color: var(--muted);
  font-size: 12px;
}

.ax-composer__thumb {
  inline-size: 24px;
  block-size: 24px;
  border-radius: 4px;
  object-fit: cover;
}

.ax-composer__file-name {
  overflow: hidden;
  max-inline-size: 22ch;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-composer__file-remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 24px;
  block-size: 24px;
  border-radius: 50%;
  color: var(--muted);
}

.ax-composer__file-remove:hover {
  background: var(--surface-raised);
  color: var(--ink);
}

.ax-composer__row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
  inline-size: 100%;
  max-inline-size: var(--chat-column);
  margin-inline: auto;
  padding: 4px var(--space-1) 4px 2px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-raised);
}

.ax-composer__row:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent);
}

.ax-composer__attach,
.ax-composer__send {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 40px;
  block-size: 40px;
  border-radius: 50%;
}

.ax-composer__attach {
  color: var(--muted);
}

.ax-composer__attach:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-composer__file-input {
  display: none;
}

.ax-composer__input {
  flex: 1 1 auto;
  min-inline-size: 0;
  max-block-size: 120px;
  min-block-size: 24px;
  padding: var(--space-2) var(--space-1);
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 15px;
  line-height: 1.45;
  outline: none;
  resize: none;
}

.ax-composer__input::placeholder {
  color: var(--muted);
}

.ax-composer__send {
  background: var(--accent);
  color: var(--accent-ink);
  transition: opacity var(--motion-fast) ease, transform var(--motion-fast) ease;
}

.ax-composer__send:active:not(:disabled) {
  transform: scale(0.94);
}

.ax-composer__send:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.ax-composer button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (min-width: 768px) {
  .ax-composer {
    padding: var(--space-3) var(--space-5) var(--space-4);
  }
}
</style>
