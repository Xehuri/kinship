// @vitest-environment jsdom
/// <reference types="vitest/globals" />

import { vi } from 'vitest'
import { renderMarkdown, handleWikiLinkClick } from '@/utils/markdown'

describe('renderMarkdown', () => {
  // ==================== 标题 ====================

  it('渲染 h1 标题', () => {
    const result = renderMarkdown('# Hello')
    expect(result).toContain('<h1>Hello</h1>')
  })

  it('渲染 h2 标题', () => {
    const result = renderMarkdown('## Hello')
    expect(result).toContain('<h2>Hello</h2>')
  })

  it('渲染 h3 标题', () => {
    const result = renderMarkdown('### Hello')
    expect(result).toContain('<h3>Hello</h3>')
  })

  // ==================== 行内格式 ====================

  it('渲染加粗 **text**', () => {
    const result = renderMarkdown('**bold**')
    expect(result).toContain('<strong>bold</strong>')
  })

  it('渲染斜体 *text*', () => {
    const result = renderMarkdown('*italic*')
    expect(result).toContain('<em>italic</em>')
  })

  it('渲染行内代码 `code`', () => {
    const result = renderMarkdown('`code`')
    expect(result).toContain('<code>code</code>')
  })

  it('渲染链接 [text](url)', () => {
    const result = renderMarkdown('[click](https://example.com)')
    expect(result).toContain('<a href="https://example.com">click</a>')
  })

  // ==================== 列表 ====================

  it('渲染无序列表 - item', () => {
    const result = renderMarkdown('- item1\n- item2')
    expect(result).toContain('<ul>')
    expect(result).toContain('<li>item1</li>')
    expect(result).toContain('<li>item2</li>')
    expect(result).toContain('</ul>')
  })

  it('渲染有序列表 1. item', () => {
    const result = renderMarkdown('1. item1\n2. item2')
    expect(result).toContain('<ol>')
    expect(result).toContain('<li>item1</li>')
    expect(result).toContain('<li>item2</li>')
    expect(result).toContain('</ol>')
  })

  // ==================== 代码块 ====================

  it('渲染代码块（无语言）', () => {
    const result = renderMarkdown('```\nconst x = 1\n```')
    expect(result).toContain('class="code-surface"')
    expect(result).toContain('data-language="text"')
    expect(result).toContain('class="code-surface__gutter"')
    expect(result).toContain('class="code-surface__ln">1</span>')
    expect(result).toContain(
      '<pre class="code-surface__pre"><code class="code-surface__code">const x = 1</code></pre>',
    )
    expect(result).not.toContain('<pre><code>')
  })

  it('渲染代码块（有语言）', () => {
    const result = renderMarkdown('```python\nprint("hi")\n```')
    expect(result).toContain('data-language="python"')
    expect(result).toContain('<span class="code-surface__lang">python</span>')
    expect(result).toContain('class="code-surface__pre"')
    // HTML 特殊字符被转义 (escapeHtml 先于代码块处理)
    expect(result).toContain('print(&quot;hi&quot;)')
    expect(result).toContain('</code></pre>')
  })

  it('代码块行号与行数一致', () => {
    const result = renderMarkdown('```ts\nconst a = 1\nconst b = 2\n```')
    const numbers = result.match(/class="code-surface__ln">\d+</g) || []
    expect(numbers).toHaveLength(2)
    expect(result).toContain('2 行')
  })

  it('代码块内的 HTML 被转义, 不注入元素', () => {
    const result = renderMarkdown('```html\n<script>alert("xss")</script>\n```')
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
    expect(result).toContain('data-language="html"')
  })

  // ==================== 表格 ====================

  it('渲染表格', () => {
    const md = '| col1 | col2 |\n|---|---|\n| a | b |'
    const result = renderMarkdown(md)
    expect(result).toContain('<div class="table-scroll"><table>')
    expect(result).toContain('<th>col1</th>')
    expect(result).toContain('<th>col2</th>')
    expect(result).toContain('<td>a</td>')
    expect(result).toContain('<td>b</td>')
    expect(result).toContain('</table></div>')
  })

  it('保留表格中间的空单元格 (不丢失列)', () => {
    const md = '| col1 | col2 | col3 |\n|---|---|---|\n| a |  | c |'
    const result = renderMarkdown(md)
    expect(result).toContain('<td>a</td>')
    // 中间的空单元格必须保留, 否则后续列整体左移导致错位
    expect(result).toContain('<td></td>')
    expect(result).toContain('<td>c</td>')
    const tdCount = (result.match(/<td>/g) || []).length
    expect(tdCount).toBe(3)
  })

  it('含空单元格的行与满行按表头列数对齐', () => {
    const md = '| h1 | h2 | h3 |\n|---|---|---|\n| a |  | c |\n| x | y | z |'
    const result = renderMarkdown(md)
    const rows = result.match(/<tr>[\s\S]*?<\/tr>/g) || []
    // 1 行表头 + 2 行数据
    expect(rows.length).toBe(3)
    // 每行单元格数一致 (均为 3), 列对齐
    expect((rows[0].match(/<t[hd]>/g) || []).length).toBe(3)
    expect((rows[1].match(/<td>/g) || []).length).toBe(3)
    expect((rows[2].match(/<td>/g) || []).length).toBe(3)
  })

  it('数据行缺列时按表头数量补空单元格', () => {
    const md = '| a | b | c |\n|---|---|---|\n| 1 | 2 |'
    const result = renderMarkdown(md)
    // 第三列缺失时补空 <td>, 保证列对齐
    expect((result.match(/<td>/g) || []).length).toBe(3)
  })

  // ==================== 引用 ====================

  // 注意: 当前 escapeHtml 在 markdown 解析前执行,
  // 导致 > 被转义为 &gt;, blockquote 语法暂不生效.
  // 以下测试验证实际输出行为 (非理想行为).

  it('处理 > 引用文本 (escapeHtml 导致 > 被转义)', () => {
    const result = renderMarkdown('> 引用文本')
    expect(result).toContain('&gt; 引用文本')
  })

  // ==================== Obsidian callouts ====================

  it('处理 > [!warning] 文本 (escapeHtml 导致 > 被转义)', () => {
    const result = renderMarkdown('> [!warning] 警告\n> 这是一个警告')
    expect(result).toContain('&gt; [!warning]')
    expect(result).toContain('&gt; 这是一个警告')
  })

  // ==================== Wiki-links ====================

  it('渲染 wiki-link [[link]]', () => {
    const result = renderMarkdown('[[笔记名称]]')
    expect(result).toContain('class="wiki-link"')
  })

  it('渲染 wiki-link 带显示文本 [[link|display]]', () => {
    const result = renderMarkdown('[[笔记|其他名称]]')
    expect(result).toMatch(/其他名称/)
    expect(result).toContain('class="wiki-link"')
  })

  it('wiki-link 不含内联 onclick (CSP 友好, FE-L3)', () => {
    const result = renderMarkdown('[[笔记名称]]')
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('alert(')
    expect(result).toContain('data-wiki-target="笔记名称"')
  })

  it('wiki-link 带显示文本时 data-wiki-target 保留原始目标', () => {
    const result = renderMarkdown('[[目标笔记|显示名]]')
    expect(result).not.toContain('onclick')
    expect(result).toContain('data-wiki-target="目标笔记"')
    expect(result).toContain('显示名')
  })

  it('handleWikiLinkClick 事件委托弹出 wiki-link 目标', () => {
    const anchor = document.createElement('a')
    anchor.className = 'wiki-link'
    anchor.dataset.wikiTarget = '笔记名称'
    const preventDefault = vi.fn()
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    handleWikiLinkClick({ target: anchor, preventDefault } as unknown as Event)
    expect(preventDefault).toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalledWith('[[ 笔记名称 ]]')
    alertSpy.mockRestore()
  })

  it('handleWikiLinkClick 对非 wiki-link 目标不响应', () => {
    const span = document.createElement('span')
    const preventDefault = vi.fn()
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    handleWikiLinkClick({ target: span, preventDefault } as unknown as Event)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  // ==================== XSS 保护 ====================

  it('转义 XSS <script> 标签', () => {
    const result = renderMarkdown('<script>alert("xss")</script>')
    expect(result).not.toContain('<script>')
    expect(result).not.toContain('alert("xss")')
    expect(result).toContain('&lt;script&gt;')
    expect(result).toContain('&lt;/script&gt;')
  })

  // ==================== 水平线 ====================

  it('渲染水平线 ---', () => {
    const result = renderMarkdown('---')
    expect(result).toContain('<hr>')
  })

  it('渲染水平线 ***', () => {
    const result = renderMarkdown('***')
    expect(result).toContain('<hr>')
  })

  // ==================== 空 / 边界 ====================

  it('处理空字符串', () => {
    const result = renderMarkdown('')
    expect(typeof result).toBe('string')
  })

  it('处理纯文本段落', () => {
    const result = renderMarkdown('Hello World')
    expect(result).toContain('<p>Hello World</p>')
  })

  // ==================== 综合 ====================

  it('标题中的行内格式', () => {
    const result = renderMarkdown('# **粗体标题**')
    expect(result).toContain('<h1>')
    expect(result).toContain('<strong>粗体标题</strong>')
    expect(result).toContain('</h1>')
  })

  it('YAML frontmatter 被剥离', () => {
    const md = '---\ntitle: test\n---\n\n# Hello'
    const result = renderMarkdown(md)
    expect(result).not.toContain('title: test')
    expect(result).toContain('<h1>Hello</h1>')
  })

  // ==================== LaTeX 数学公式 ====================

  it('渲染块级公式 $$...$$', () => {
    const result = renderMarkdown('$$E=mc^2$$')
    expect(result).toContain('katex')
    expect(result).toContain('m')
    expect(result).toContain('c')
  })

  it('渲染行内公式 $...$', () => {
    const result = renderMarkdown('值为 $x_i$ 的平方')
    expect(result).toContain('katex')
    expect(result).toContain('x')
  })

  it('LaTeX 与 Markdown 混合', () => {
    const md = '# 公式\n\n面积 $S=\\pi r^2$，其中 $r$ 为半径。\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$'
    const result = renderMarkdown(md)
    expect(result).toContain('<h1>')
    expect(result).toContain('katex')
    // katex 应为 2 个行内 + 1 个块级
    const katexCount = (result.match(/class="katex"/g) || []).length
    expect(katexCount).toBeGreaterThanOrEqual(2)
  })

  it('不误渲染普通文本中的 $ 符号', () => {
    const result = renderMarkdown('价格是 $5.00')
    expect(result).not.toContain('katex')
    expect(result).toContain('$5.00')
  })

  it('空 $$ 不崩溃', () => {
    const result = renderMarkdown('$$$$')
    expect(typeof result).toBe('string')
  })

  it('公式内含单引号撇号不被转义破坏', () => {
    // 回归: 旧管线先 escapeHtml ('→&#039;) 再喂 KaTeX, 导致解析失败。
    // 修复后公式提取在 escapeHtml 之前, 撇号原样传给 KaTeX。
    const md = `电流 $I_1' = 2A$ 且 $I_2' = 3A$`
    const result = renderMarkdown(md)
    expect(result).toContain('katex')
    expect(result).not.toContain('&#039;')
    expect(result).not.toContain('katex-error')
    expect(result).not.toContain('KaTeX parse error')
  })

  it('公式内含大于号不被转义破坏 (如 a > 0)', () => {
    const md = '条件 $a, b > 0$ 成立'
    const result = renderMarkdown(md)
    expect(result).toContain('katex')
    expect(result).not.toContain('katex-error')
    expect(result).not.toContain('KaTeX parse error')
  })

  it('公式内含小于号不被转义破坏 (如 gamma_min < 40°)', () => {
    const md = '要求 $\\gamma_{\\min} < 40°$ 不合格'
    const result = renderMarkdown(md)
    expect(result).toContain('katex')
    expect(result).not.toContain('katex-error')
    expect(result).not.toContain('KaTeX parse error')
  })

  it('公式内含 & 不被转义破坏 (aligned 环境)', () => {
    const md = `$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$`
    const result = renderMarkdown(md)
    expect(result).toContain('katex')
    expect(result).not.toContain('katex-error')
    expect(result).not.toContain('KaTeX parse error')
  })

  it('四杆机构传动角公式整体可渲染', () => {
    const md =
      "$$\\gamma' = \\arccos\\dfrac{b^2+c^2-(d-a)^2}{2bc}（曲柄和机架重叠共线）$$"
    const result = renderMarkdown(md)
    expect(result).toContain('katex')
    expect(result).not.toContain('katex-error')
    expect(result).not.toContain('KaTeX parse error')
  })

  // ==================== SVG 代码块 ====================

  it('渲染 ```svg 代码块为 .svg-diagram 且保留原文', () => {
    const md = '```svg\n<svg viewBox="0 0 100 50"><line x1="10" y1="25" x2="90" y2="25" stroke="white"/></svg>\n```'
    const result = renderMarkdown(md)
    expect(result).toContain('class="svg-diagram"')
    expect(result).toContain('<svg viewBox="0 0 100 50">')
    expect(result).toContain('stroke="white"')
    // 不应被 escapeHtml 转义
    expect(result).not.toContain('&lt;svg')
  })

  it('SVG 块内 <script> 被移除 (XSS 防护)', () => {
    const md = '```svg\n<svg><script>alert("xss")</script><rect width="10" height="10"/></svg>\n```'
    const result = renderMarkdown(md)
    expect(result).not.toContain('<script>')
    expect(result).not.toContain('alert')
    expect(result).toContain('<rect')
  })

  it('SVG 块内 on* 事件属性被移除 (XSS 防护)', () => {
    const md = '```svg\n<svg><circle cx="10" cy="10" r="5" onclick="evil()"/></svg>\n```'
    const result = renderMarkdown(md)
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('evil')
    expect(result).toContain('<circle')
  })

  it('SVG 块内 javascript: 协议被移除 (XSS 防护)', () => {
    const md = '```svg\n<svg><a href="javascript:alert(1)">x</a></svg>\n```'
    const result = renderMarkdown(md)
    expect(result).not.toContain('javascript:')
  })

  it('SVG 块内 <foreignObject> 被移除 (XSS 防护)', () => {
    const md = '```svg\n<svg><foreignObject><div>html</div></foreignObject></svg>\n```'
    const result = renderMarkdown(md)
    expect(result).not.toContain('foreignObject')
    expect(result).not.toContain('<div>html</div>')
  })

  it('SVG 图块前后的文本正常渲染', () => {
    const md = '电路如下：\n\n```svg\n<svg><line x1="0" y1="0" x2="10" y2="10"/></svg>\n```\n\n完成。'
    const result = renderMarkdown(md)
    expect(result).toContain('<p>电路如下：</p>')
    expect(result).toContain('class="svg-diagram"')
    expect(result).toContain('<p>完成。</p>')
  })

  // ==================== Mermaid 代码块 ====================

  it('渲染 ```mermaid 代码块为 .mermaid-block 且内容转义', () => {
    const md = '```mermaid\ngraph TD\nA --> B\n```'
    const result = renderMarkdown(md)
    expect(result).toContain('class="mermaid-block"')
    expect(result).toContain('graph TD')
    expect(result).toContain('A --&gt; B')
  })

  it('普通代码块不受影响 (非 svg/mermaid)', () => {
    const md = '```python\nprint("<svg>")  # 正常代码\n```'
    const result = renderMarkdown(md)
    expect(result).not.toContain('svg-diagram')
    expect(result).not.toContain('mermaid-block')
    expect(result).toContain('data-language="python"')
  })

  // ==================== CircuitJS 代码块 ====================

  it('渲染 ```circuitjs 代码块为 .circuitjs-block 且含 data-ctz', () => {
    const md = '```circuitjs\n$ 1 5.0E-6 10.20027730826997 50 5.0 50\nr 1 2 1000\ng 2\n```'
    const result = renderMarkdown(md)
    expect(result).toContain('class="circuitjs-block"')
    expect(result).toMatch(/data-ctz="[^"]+"/)
    // 电路文本不应被 escapeHtml 转义 (原样压缩进 data-ctz)
    expect(result).not.toContain('5.0E-6&quot;')
  })

  it('渲染 ```circuit 代码块 (别名) 同样输出 .circuitjs-block', () => {
    const md = '```circuit\n$ 1 5.0E-6 10 50 5.0 50\nv 1 2 0 1 0\n```'
    const result = renderMarkdown(md)
    expect(result).toContain('class="circuitjs-block"')
    expect(result).toMatch(/data-ctz="[^"]+"/)
  })

  it('data-ctz 解压后还原原始电路文本', () => {
    const { decompressFromEncodedURIComponent } = require('lz-string')
    const md = '```circuitjs\n$ 1 5.0E-6 10.20027730826997 50 5.0 50\nr 320 336 320 208 0 1000\nw 96 336 320 336 0\ng 96 96 96 64 0\n```'
    const result = renderMarkdown(md)
    const m = result.match(/data-ctz="([^"]+)"/)
    expect(m).toBeTruthy()
    const decoded = decompressFromEncodedURIComponent(m![1])
    expect(decoded).toContain('$ 1 5.0E-6')
    expect(decoded).toContain('r 320 336 320 208 0 1000')
    expect(decoded).toContain('g 96 96 96 64 0')
  })

  it('circuitjs 图块在段落包裹场景下兜底恢复 (含前后文本)', () => {
    const md = '电路如下：\n\n```circuitjs\n$ 1 5.0E-6 10 50 5.0 50\nr 1 2 1000\ng 2\n```\n\n完成。'
    const result = renderMarkdown(md)
    expect(result).toContain('<p>电路如下：</p>')
    expect(result).toContain('class="circuitjs-block"')
    expect(result).toContain('<p>完成。</p>')
  })

  it('circuitjs 代码块不落入 mermaid 分支', () => {
    const md = '```circuitjs\n$ 1 5.0E-6 10 50 5.0 50\nr 1 2 1000\n```'
    const result = renderMarkdown(md)
    expect(result).not.toContain('mermaid-block')
    expect(result).toContain('circuitjs-block')
  })

  // ==================== 链接协议白名单 (S5/FE-C2) ====================

  it('拒绝 javascript: 链接, 降级为纯文本', () => {
    const result = renderMarkdown('[x](javascript:alert(1))')
    expect(result).not.toContain('javascript:')
    expect(result).not.toContain('<a ')
    expect(result).toContain('x')
  })

  it('拒绝 data: 链接, 不生成 <a>', () => {
    const result = renderMarkdown('[x](data:text/html,<b>)')
    expect(result).not.toContain('<a ')
  })

  it('拒绝 vbscript: 链接, 不生成 <a>', () => {
    const result = renderMarkdown('[x](vbscript:x)')
    expect(result).not.toContain('<a ')
  })

  it('允许 https: 链接', () => {
    const result = renderMarkdown('[x](https://example.com)')
    expect(result).toContain('<a href="https://example.com">x</a>')
  })

  it('允许 http: 链接', () => {
    const result = renderMarkdown('[x](http://example.com)')
    expect(result).toContain('<a href="http://example.com">x</a>')
  })

  it('允许 mailto: 链接', () => {
    const result = renderMarkdown('[x](mailto:a@b.com)')
    expect(result).toContain('<a href="mailto:a@b.com">x</a>')
  })

  it('允许相对路径链接 (/ ./ ../ #)', () => {
    expect(renderMarkdown('[x](/mobile/x)')).toContain('<a href="/mobile/x">x</a>')
    expect(renderMarkdown('[x](./a/b)')).toContain('<a href="./a/b">x</a>')
    expect(renderMarkdown('[x](../a)')).toContain('<a href="../a">x</a>')
    expect(renderMarkdown('[x](#anchor)')).toContain('<a href="#anchor">x</a>')
  })

  it('拒绝协议相对地址 //evil.com', () => {
    const result = renderMarkdown('[x](//evil.com)')
    expect(result).not.toContain('<a ')
    expect(result).not.toContain('evil.com')
  })

  // ==================== SVG 清洗绕过防护 (S4/FE-C1) ====================

  it('拦截 <svg/onload=...> 自闭合事件属性绕过', () => {
    const result = renderMarkdown('```svg\n<svg/onload=alert(1)>\n```')
    expect(result).not.toContain('onload')
    expect(result).not.toContain('alert(')
  })

  it('拦截 <svg onload=...> 事件属性', () => {
    const result = renderMarkdown('```svg\n<svg onload=alert(1)></svg>\n```')
    expect(result).not.toContain('onload')
    expect(result).not.toContain('alert(')
  })

  it('拦截实体编码 javascript: 协议 (java&#115;cript:)', () => {
    const result = renderMarkdown('```svg\n<svg><a href="java&#115;cript:alert(1)">x</a></svg>\n```')
    expect(result).not.toContain('alert(')
  })

  it('拦截自闭合 <foreignObject/>', () => {
    const result = renderMarkdown('```svg\n<svg><foreignObject/></svg>\n```')
    expect(result).not.toContain('foreignObject')
  })

  it('正常 SVG 仍保留在 .svg-diagram 内', () => {
    const md =
      '```svg\n<svg viewBox="0 0 100 50"><line x1="10" y1="25" x2="90" y2="25" stroke="white"/></svg>\n```'
    const result = renderMarkdown(md)
    expect(result).toContain('class="svg-diagram"')
    expect(result).toContain('<svg')
    expect(result).toContain('viewBox="0 0 100 50"')
    expect(result).toContain('stroke="white"')
  })
})
