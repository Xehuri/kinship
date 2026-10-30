/**
 * 自定义 Markdown 渲染器
 *
 * 匹配 index.original.html 中 renderMarkdown 和 renderObsidianMarkdown 的行为,
 * 合并两者的能力:
 *   - renderMarkdown: 列表分组 (<ul>/<ol>), 代码块语言类, 链接, escapeHtml 前置
 *   - renderObsidianMarkdown: 表格, Obsidian callouts, wiki-links
 * LaTeX 数学公式: $$...$$ (块级) + $...$ (行内) → KaTeX 渲染
 */

import DOMPurify from 'dompurify'
import katex from 'katex'
import { compressToEncodedURIComponent } from 'lz-string'

/** 转义 HTML 特殊字符防止 XSS */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 清理 SVG 中的危险内容防止 XSS 注入。
 *
 * 使用 DOMPurify 的 SVG profile 白名单过滤 (替代旧的手写正则 —— 正则可被
 * `<svg/onload=...>`、实体编码 `on&#108;oad=`、自闭合 `<foreignObject/>` 等绕过):
 *  - 移除 <script> / on* 事件属性 / javascript: 协议链接
 *  - 禁止 <foreignObject> (可内嵌 HTML, 存在注入风险)
 *  - 保留正常 SVG 元素 (viewBox / line / rect / circle / path / text / style 等)
 */
function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script'],
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * 判断链接 URL 是否安全 (协议白名单)。
 *
 * 仅允许: http: / https: / mailto:, 以及相对路径 (/ ./ ../ #)。
 * 明确拒绝协议相对地址 `//evil.com` (看似相对实为绝对跳转),
 * 以及 javascript: / data: / vbscript: 等可执行协议。
 */
function isSafeUrl(url: string): boolean {
  const u = url.trim()
  if (!u) return false
  // 协议相对地址 `//host/...` 不是相对路径, 拒绝
  if (u.startsWith('//')) return false
  if (/^https?:/i.test(u)) return true
  if (/^mailto:/i.test(u)) return true
  // 相对路径: /  ./  ../  #
  if (/^(\/|\.\/|\.\.\/|#)/.test(u)) return true
  return false
}

/** 转义 HTML 属性中的引号 */
function escapeAttr(s: string): string {
  return String(s).replace(/['"]/g, '')
}

/**
 * 拆分表格行为单元格数组。
 *
 * 首尾管道 `| a | b |` 会 split 出两个空边框元素, 需移除;
 * 但中间的合法空单元格 `| a |  | c |` 必须保留, 否则列会错位
 * (旧实现用 filter 丢弃所有空串, 导致空单元格被删、后续列整体左移)。
 */
function splitTableRow(row: string): string[] {
  const cells = row.split('|')
  if (cells.length > 0 && cells[0].trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells
}

/** 行内格式化: wiki-links, 行内代码, 加粗, 斜体, 链接 */
function inlineFormat(text: string): string {
  return text
    // wiki-links 优先, 避免与 [text](url) 冲突
    // CSP 友好: 不输出内联 onclick, 改为 data-wiki-target + 全局事件委托 (见 handleWikiLinkClick)
    .replace(/\[\[([^\]]+?)\]\]/g, (_match: string, p1: string) => {
      const parts = p1.split('|')
      const display = parts[1] || parts[0]
      return (
        '<a class="wiki-link" data-wiki-target="' +
        escapeAttr(parts[0]) +
        '">' +
        escapeHtml(display) +
        '</a>'
      )
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, text: string, url: string) => {
      // 协议白名单: 不安全协议 (javascript:/data:/vbscript: 等) 降级为纯文本
      if (!isSafeUrl(url)) return text
      return '<a href="' + escapeAttr(url) + '">' + text + '</a>'
    })
}

/** 全局 wiki-link 点击委托是否已绑定 (幂等注册标志) */
let _wikiLinkBound = false

/**
 * wiki-link 点击处理 (全局事件委托, CSP 友好)。
 *
 * 背景 (FE-L3): 旧实现把 `onclick="alert(...)"` 内联进 <a> 字符串,
 * 与严格 CSP (禁止 unsafe-inline) 冲突。现改为渲染时只写
 * `data-wiki-target` 属性, 由本函数在 document 层统一拦截 `.wiki-link`
 * 的点击, 行为保持不变 (弹出 `[[ 目标 ]]` 提示)。
 */
export function handleWikiLinkClick(e: Event): void {
  const target = e.target as Element | null
  if (!target || typeof target.closest !== 'function') return
  const link = target.closest<HTMLElement>('a.wiki-link')
  if (!link) return
  e.preventDefault()
  const name = link.dataset.wikiTarget || ''
  window.alert('[[ ' + name + ' ]]')
}

/**
 * 幂等注册 wiki-link 全局点击委托 (在应用入口调用一次即可)。
 * 重复调用不会重复绑定监听。
 */
export function bindWikiLinkHandler(): void {
  if (_wikiLinkBound) return
  document.addEventListener('click', handleWikiLinkClick)
  _wikiLinkBound = true
}

/**
 * 将 Markdown 文本渲染为安全的 HTML 字符串.
 *
 * 支持的语法:
 *   - 标题: # / ## / ###
 *   - 加粗: **text**
 *   - 斜体: *text*
 *   - 链接: [text](url)
 *   - 无序列表: - item / * item (自动包裹 <ul>)
 *   - 有序列表: 1. item (自动包裹 <ol>)
 *   - 代码块: 三反引号 (可指定语言类)
 *   - 行内代码: `code`
 *   - 引用: > text
 *   - Obsidian callouts: > [!warning] / > [!tip] / > [!abstract] 等
 *   - 表格: | col1 | col2 |  + 分隔行
 *   - 水平线: --- / ***
 *   - Wiki-links: [[link]] / [[link|display]]
 *   - YAML frontmatter 自动剥离
 */
export function renderMarkdown(text: string): string {
  // 0. 提取 SVG / Mermaid / CircuitJS 代码块 → 占位符 (必须在 escapeHtml 之前, 保留原始内容)
  const diagramBlocks: Array<{ lang: string; code: string }> = []
  text = text.replace(/```(svg|mermaid|circuitjs|circuit)\s*\n?([\s\S]*?)```/gi, (_m: string, lang: string, code: string) => {
    const idx = diagramBlocks.length
    diagramBlocks.push({ lang: lang.toLowerCase(), code })
    return '\x00DIAG_' + idx + '\x00'
  })

  // 1. 提取并渲染 LaTeX 数学公式 → 占位符
  //    必须在 escapeHtml 之前: 公式内常含 ' > < & 等字符, 若先转义 (如 ' → &#039;),
  //    KaTeX 会收到实体文本 (I_1&#039;) 解析失败。此处先提取, 公式内容原样喂给 KaTeX。
  const mathBlocks: string[] = []
  // 1a. 块级 $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m: string, latex: string) => {
    const idx = mathBlocks.length
    try {
      mathBlocks.push(katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false }))
    } catch {
      mathBlocks.push(_m)
    }
    return '\x00MATH_B_' + idx + '\x00'
  })
  // 1b. 行内 $...$ (内容两端非空白, 不含换行)
  text = text.replace(/\$(\S[^$\n]*?\S)\$/g, (_m: string, latex: string) => {
    const idx = mathBlocks.length
    try {
      mathBlocks.push(katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false }))
    } catch {
      mathBlocks.push(_m)
    }
    return '\x00MATH_I_' + idx + '\x00'
  })

  // 2. XSS 保护: 先转义 HTML (公式/SVG/Mermaid 已替换为不含特殊字符的占位符, 不受影响)
  text = escapeHtml(text)

  // 3. 剥离 YAML frontmatter
  text = text.replace(/^---[\s\S]*?---\n*/, '')

  const lines = text.split('\n')
  let html = ''
  let inCode = false
  let codeLang = ''
  const codeLines: string[] = []
  let listType: 'ul' | 'ol' | null = null
  const listItems: string[] = []

  /** 刷新当前列表 (闭合 <ul>/<ol>) */
  function flushList(): void {
    if (listType) {
      html += '<' + listType + '>' + listItems.join('') + '</' + listType + '>'
      listType = null
      listItems.length = 0
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ── 代码块 ──────────────────────────────────────────
    if (/^```/.test(line)) {
      if (inCode) {
        html += renderCodeSurface(codeLang, codeLines)
        inCode = false
        codeLang = ''
        codeLines.length = 0
      } else {
        inCode = true
        codeLang = line.slice(3).trim()
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }

    // ── SVG / Mermaid / CircuitJS 图块 ─────────────────
    const diagMatch = line.match(/^\x00DIAG_(\d+)\x00$/)
    if (diagMatch) {
      flushList()
      const block = diagramBlocks[parseInt(diagMatch[1], 10)]
      if (block) {
        html += renderDiagramBlock(block)
      }
      continue
    }

    // ── 关闭已打开的列表 ───────────────────────────────
    if (listType) {
      const isListItem = /^(\d+\.\s|[-*+]\s)/.test(line)
      if (!isListItem) {
        flushList()
      }
    }

    // ── 空行 ─────────────────────────────────────────────
    if (!line.trim()) {
      html += '<br>'
      continue
    }

    // ── 表格: 检测 |...| 表头 + 下一行 |---|---| 分隔 ──
    if (
      /^\|.+/.test(line) &&
      /\|$/.test(line) &&
      i + 1 < lines.length &&
      /^\|[-:\s|]+\|$/.test(lines[i + 1])
    ) {
      const headers = splitTableRow(line)
      const columnCount = headers.length
      let tableHtml = '<table><thead><tr>'
      headers.forEach((cell) => {
        tableHtml += '<th>' + inlineFormat(cell.trim()) + '</th>'
      })
      tableHtml += '</tr></thead><tbody>'
      i++ // 跳过分隔行
      i++ // 移动到第一个数据行
      while (i < lines.length) {
        const dataLine = lines[i]
        if (!/^\|/.test(dataLine)) {
          i--
          break
        }
        const cells = splitTableRow(dataLine)
        tableHtml += '<tr>'
        // 按表头列数补齐/截断: 保留空单元格, 保证列对齐
        for (let c = 0; c < columnCount; c++) {
          tableHtml += '<td>' + inlineFormat((cells[c] ?? '').trim()) + '</td>'
        }
        tableHtml += '</tr>'
        i++
      }
      html += '<div class="table-scroll">' + tableHtml + '</tbody></table></div>'
      continue
    }

    // ── Obsidian callouts ──────────────────────────────
    const calloutMatch = line.match(/^>\s*\[!(\w+)\]\s*(.*)/i)
    if (calloutMatch) {
      const calloutType = calloutMatch[1].toLowerCase()
      const calloutTitle = calloutMatch[2] || calloutType
      html +=
        '<div class="callout callout-' +
        calloutType +
        '"><div class="callout-title">' +
        escapeHtml(calloutTitle) +
        '</div><div class="callout-body">'
      i++
      while (i < lines.length && lines[i].startsWith('>')) {
        html += '<p>' + inlineFormat(lines[i].replace(/^>\s*/, '')) + '</p>'
        i++
      }
      html += '</div></div>'
      i--
      continue
    }

    // ── 普通 blockquote ─────────────────────────────────
    if (line.startsWith('>')) {
      html +=
        '<blockquote>' + inlineFormat(line.replace(/^>\s*/, '')) + '</blockquote>'
      continue
    }

    // ── 水平线 ───────────────────────────────────────────
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      html += '<hr>'
      continue
    }

    // ── 标题 h1 / h2 / h3 ──────────────────────────────
    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length
      const title = line.replace(/^#+\s*/, '')
      html += '<h' + level + '>' + inlineFormat(title) + '</h' + level + '>'
      continue
    }

    // ── 无序列表 ────────────────────────────────────────
    const ulMatch = line.match(/^[-*+]\s(.+)/)
    if (ulMatch) {
      if (listType !== 'ul') {
        flushList()
        listType = 'ul'
      }
      listItems.push('<li>' + inlineFormat(ulMatch[1]) + '</li>')
      continue
    }

    // ── 有序列表 ────────────────────────────────────────
    const olMatch = line.match(/^\d+\.\s(.+)/)
    if (olMatch) {
      if (listType !== 'ol') {
        flushList()
        listType = 'ol'
      }
      listItems.push('<li>' + inlineFormat(olMatch[1]) + '</li>')
      continue
    }

    // ── 普通段落 ────────────────────────────────────────
    html += '<p>' + inlineFormat(line) + '</p>'
  }

  // ── 收尾: 闭合未关闭的结构 ─────────────────────────
  flushList()
  if (inCode) {
    html += renderCodeSurface(codeLang, codeLines)
  }

  // ── 恢复 LaTeX 占位符 ────────────────────────────────
  html = html.replace(/\x00MATH_[BI]_(\d+)\x00/g, (_m: string, idx: string) => {
    return mathBlocks[parseInt(idx)] ?? _m
  })

  // ── 兜底恢复 SVG / Mermaid / CircuitJS 占位符 (被 <p> 包裹时闭合) ──
  html = html.replace(/\x00DIAG_(\d+)\x00/g, (_m: string, idx: string) => {
    const block = diagramBlocks[parseInt(idx, 10)]
    if (!block) return _m
    return '</p>' + renderDiagramBlock(block) + '<p>'
  })

  return html
}

/**
 * 渲染与 CodeSurface.vue 完全一致的代码块结构。
 * 代码行在进入解析器前已由 escapeHtml 转义, 这里只做结构拼装。
 */
function renderCodeSurface(language: string, codeLines: string[]): string {
  const label = language || 'text'
  const gutter = codeLines
    .map((_line, index) => '<span class="code-surface__ln">' + (index + 1) + '</span>')
    .join('')
  return (
    '<div class="code-surface" data-testid="code-surface" data-language="' +
    label +
    '">' +
    '<div class="code-surface__header">' +
    '<span class="code-surface__lang">' +
    label +
    '</span>' +
    '<span class="code-surface__count">' +
    codeLines.length +
    ' 行</span>' +
    '</div>' +
    '<div class="code-surface__scroller">' +
    '<div class="code-surface__gutter" aria-hidden="true">' +
    gutter +
    '</div>' +
    '<pre class="code-surface__pre"><code class="code-surface__code">' +
    codeLines.join('\n') +
    '</code></pre>' +
    '</div>' +
    '</div>'
  )
}

/**
 * 渲染图块 HTML (SVG / Mermaid / CircuitJS)。
 * circuitjs 块输出容器 + LZString 压缩后的电路文本 (data-ctz),
 * iframe 由 MarkdownContent.vue 在组件层根据 BASE_URL 动态挂载。
 */
function renderDiagramBlock(block: { lang: string; code: string }): string {
  if (block.lang === 'svg') {
    return '<div class="svg-diagram">' + sanitizeSvg(block.code) + '</div>'
  }
  if (block.lang === 'mermaid') {
    return '<div class="mermaid-block">' + escapeHtml(block.code) + '</div>'
  }
  // circuitjs / circuit: 压缩电路文本, iframe 在组件层按需挂载
  const ctz = compressToEncodedURIComponent(block.code)
  return '<div class="circuitjs-block" data-ctz="' + escapeHtml(ctz) + '"></div>'
}

/**
 * 根据 SVG 的 viewBox 设置 aspect-ratio, 让 max-width / max-height 约束按比例缩放。
 *
 * 背景: 只有 viewBox 而无 width/height 属性的 SVG (AI 生成的电路图常见),
 * 浏览器无法从 CSS 推断其固有宽高比 —— max-height 截断时宽度不会跟着缩小,
 * 导致图片显示不全。显式设置 aspect-ratio 后, max-width/max-height 按比例生效。
 */
export function applySvgAspectRatio(root: HTMLElement): void {
  root.querySelectorAll<SVGSVGElement>('.svg-diagram svg, .mermaid-block svg').forEach((svg) => {
    if (svg.style.aspectRatio) return // 已设置过
    const vb = svg.viewBox?.baseVal
    if (vb && vb.width > 0 && vb.height > 0) {
      svg.style.aspectRatio = `${vb.width} / ${vb.height}`
    }
  })
}

/**
 * 根据 SVG 内部元素的实际边界自动扩展 viewBox, 解决内容超出 viewBox 被裁剪的问题。
 *
 * 背景: AI 生成的 SVG 常出现 viewBox 与内容不符 (如 viewBox="0 0 300 240"
 * 但内部元素画到了 340 高度), SVG 规范默认裁剪 viewBox 之外的内容, 导致图显示不全。
 * 遍历所有子元素计算 bbox 并集, 若超出原 viewBox 则扩展之, 并同步 aspect-ratio。
 */
export function fitSvgElement(svg: SVGSVGElement): void {
  try {
    // 遍历子元素计算实际内容边界
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const els = svg.querySelectorAll<SVGGraphicsElement>('*')
    if (!els.length) return
    els.forEach((el) => {
      let bbox: DOMRect | null = null
      try {
        bbox = el.getBBox()
      } catch {
        return
      }
      if (!bbox || (bbox.width === 0 && bbox.height === 0)) return
      minX = Math.min(minX, bbox.x)
      minY = Math.min(minY, bbox.y)
      maxX = Math.max(maxX, bbox.x + bbox.width)
      maxY = Math.max(maxY, bbox.y + bbox.height)
    })
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return
    if (minX >= maxX || minY >= maxY) return

    const pad = 8 // 四周留白, 避免线条/文字贴边
    const newMinX = minX - pad
    const newMinY = minY - pad
    const newW = maxX - minX + pad * 2
    const newH = maxY - minY + pad * 2

    // 仅在内容超出原 viewBox 时才扩展, 保持原坐标原点尽量不动
    const oldVb = svg.viewBox?.baseVal
    if (oldVb && oldVb.width > 0 && oldVb.height > 0) {
      const needExpand =
        minX < oldVb.x - 1 || minY < oldVb.y - 1 || maxX > oldVb.x + oldVb.width + 1 || maxY > oldVb.y + oldVb.height + 1
      if (!needExpand) return
      // 融合: 保留原 viewBox 与内容边界的并集
      const unionMinX = Math.min(oldVb.x, newMinX)
      const unionMinY = Math.min(oldVb.y, newMinY)
      const unionMaxX = Math.max(oldVb.x + oldVb.width, maxX + pad)
      const unionMaxY = Math.max(oldVb.y + oldVb.height, maxY + pad)
      svg.setAttribute('viewBox', `${unionMinX} ${unionMinY} ${unionMaxX - unionMinX} ${unionMaxY - unionMinY}`)
    } else {
      svg.setAttribute('viewBox', `${newMinX} ${newMinY} ${newW} ${newH}`)
    }

    // 同步 aspect-ratio (基于扩展后的 viewBox)
    const vb = svg.viewBox?.baseVal
    if (vb && vb.width > 0 && vb.height > 0) {
      svg.style.aspectRatio = `${vb.width} / ${vb.height}`
    }
  } catch {
    // 计算异常时静默跳过, 不影响渲染
  }
}

/** 遍历 root 下所有 .svg-diagram 内 SVG 自动扩展 viewBox (仅手绘 SVG, mermaid 的 viewBox 是准确的) */
export function fitSvgViewBox(root: HTMLElement): void {
  root.querySelectorAll<SVGSVGElement>('.svg-diagram svg').forEach(fitSvgElement)
}
