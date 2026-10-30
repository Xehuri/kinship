<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  PhArrowClockwise,
  PhArrowRight,
  PhArrowSquareOut,
  PhArrowUp,
  PhArrowsClockwise,
  PhBatteryCharging,
  PhBatteryFull,
  PhBell,
  PhBrain,
  PhCaretDown,
  PhCaretLeft,
  PhCaretRight,
  PhCaretUp,
  PhChartBar,
  PhChatCircle,
  PhChatCircleDots,
  PhChatCircleText,
  PhChatTeardropText,
  PhCheck,
  PhCheckCircle,
  PhCircle,
  PhCircleNotch,
  PhClock,
  PhCode,
  PhCopy,
  PhDatabase,
  PhDesktop,
  PhDesktopTower,
  PhDeviceMobile,
  PhDotsThree,
  PhDownload,
  PhDrop,
  PhFileText,
  PhFiles,
  PhFolder,
  PhFootprints,
  PhFunnel,
  PhGear,
  PhGitBranch,
  PhGlobe,
  PhHash,
  PhHeartbeat,
  PhImage,
  PhInfo,
  PhLightning,
  PhLink,
  PhListChecks,
  PhLock,
  PhMagnifyingGlass,
  PhMapPin,
  PhMicrophone,
  PhMonitor,
  PhMoon,
  PhMoonStars,
  PhPalette,
  PhPaperclip,
  PhPause,
  PhPlay,
  PhPlugs,
  PhPlus,
  PhPulse,
  PhRobot,
  PhSidebarSimple,
  PhSlidersHorizontal,
  PhStop,
  PhSun,
  PhTerminal,
  PhTimer,
  PhTrash,
  PhUploadSimple,
  PhUser,
  PhUsers,
  PhWarning,
  PhWarningCircle,
  PhWaveform,
  PhWrench,
  PhX,
  PhXCircle,
} from '@phosphor-icons/vue'

type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number
    weight?: IconWeight
    label?: string
  }>(),
  {
    size: 16,
    weight: 'regular',
    label: '',
  },
)

const ICONS: Record<string, Component> = {
  ArrowClockwise: PhArrowClockwise,
  ArrowRight: PhArrowRight,
  ArrowSquareOut: PhArrowSquareOut,
  ArrowUp: PhArrowUp,
  ArrowsClockwise: PhArrowsClockwise,
  BatteryCharging: PhBatteryCharging,
  BatteryFull: PhBatteryFull,
  Bell: PhBell,
  Brain: PhBrain,
  CaretDown: PhCaretDown,
  CaretLeft: PhCaretLeft,
  CaretRight: PhCaretRight,
  CaretUp: PhCaretUp,
  ChartBar: PhChartBar,
  ChatCircle: PhChatCircle,
  ChatCircleDots: PhChatCircleDots,
  ChatCircleText: PhChatCircleText,
  ChatTeardropText: PhChatTeardropText,
  Check: PhCheck,
  CheckCircle: PhCheckCircle,
  Circle: PhCircle,
  CircleNotch: PhCircleNotch,
  Clock: PhClock,
  Code: PhCode,
  Copy: PhCopy,
  Database: PhDatabase,
  Desktop: PhDesktop,
  DesktopTower: PhDesktopTower,
  DeviceMobile: PhDeviceMobile,
  DotsThree: PhDotsThree,
  Download: PhDownload,
  Drop: PhDrop,
  FileText: PhFileText,
  Files: PhFiles,
  Folder: PhFolder,
  Footprints: PhFootprints,
  Funnel: PhFunnel,
  Gear: PhGear,
  GitBranch: PhGitBranch,
  Globe: PhGlobe,
  Hash: PhHash,
  Heartbeat: PhHeartbeat,
  Image: PhImage,
  Info: PhInfo,
  Lightning: PhLightning,
  Link: PhLink,
  ListChecks: PhListChecks,
  Lock: PhLock,
  MagnifyingGlass: PhMagnifyingGlass,
  MapPin: PhMapPin,
  Microphone: PhMicrophone,
  Monitor: PhMonitor,
  Moon: PhMoon,
  MoonStars: PhMoonStars,
  Palette: PhPalette,
  Paperclip: PhPaperclip,
  Pause: PhPause,
  Play: PhPlay,
  Plugs: PhPlugs,
  Plus: PhPlus,
  Pulse: PhPulse,
  Robot: PhRobot,
  SidebarSimple: PhSidebarSimple,
  SlidersHorizontal: PhSlidersHorizontal,
  Stop: PhStop,
  Sun: PhSun,
  Terminal: PhTerminal,
  Timer: PhTimer,
  Trash: PhTrash,
  UploadSimple: PhUploadSimple,
  User: PhUser,
  Users: PhUsers,
  Warning: PhWarning,
  WarningCircle: PhWarningCircle,
  Waveform: PhWaveform,
  Wrench: PhWrench,
  X: PhX,
  XCircle: PhXCircle,
}

function normalizeIconName(name: string): string {
  const withoutPrefix = name.replace(/^ph[-_]?/i, '').replace(/^Ph(?=[A-Z])/, '')
  const camel = withoutPrefix.replace(/[-_\s]+([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase())
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

const iconComponent = computed<Component | null>(() => ICONS[normalizeIconName(props.name)] ?? null)
const placeholderLabel = computed(() => (props.label ? props.label : undefined))
</script>

<template>
  <span
    v-if="!iconComponent"
    class="icon icon--placeholder"
    :style="{ inlineSize: `${size}px`, blockSize: `${size}px` }"
    :role="placeholderLabel ? 'img' : undefined"
    :aria-label="placeholderLabel"
    :aria-hidden="placeholderLabel ? undefined : 'true'"
  />
  <component
    :is="iconComponent"
    v-else
    class="icon"
    :size="size"
    :weight="weight"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.icon {
  display: inline-block;
  flex: none;
  vertical-align: -0.125em;
}

.icon--placeholder {
  border: 1px solid var(--hairline);
  border-radius: 1px;
  background: var(--inset);
}
</style>
