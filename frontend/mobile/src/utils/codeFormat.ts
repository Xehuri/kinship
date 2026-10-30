/**
 * Code display helpers shared by the file preview and Markdown code surfaces.
 *
 * The surface renders code via plain text interpolation, so these helpers only
 * normalize content; escaping stays at the call site (Vue interpolation for the
 * component, escapeHtml for the Markdown HTML string).
 */

/**
 * Extension -> language id. This is the single source of truth: both
 * `languageFromName` and the file browser (`components/files/preview.ts`)
 * resolve their labels from it.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  vue: 'vue',
  kt: 'kotlin',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  txt: 'text',
  log: 'text',
  json: 'json',
  jsonl: 'json',
}

/** Extension (lowercased, no dot) -> language id; unknown extensions return ''. */
export function languageFromName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) return ''
  const extension = base.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXTENSION[extension] ?? ''
}

/**
 * Pretty-print valid JSON with two spaces. Invalid input is returned unchanged,
 * so plain text or a partially streamed document never gets mangled.
 */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * One entry per display line, with CRLF and lone CR normalized to LF.
 *
 * A trailing newline produces a trailing empty entry (the old text preview
 * numbered it too), and an empty string produces no lines at all.
 */
export function splitCodeLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n?/g, '\n').split('\n')
}
