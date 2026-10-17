/**
 * A file from the ⌘P browser, drawn read-only: code with line numbers and syntax colours, the
 * line you asked for marked and scrolled to; markdown rendered, with its source a click away;
 * an image as itself. Shown in the panel beside the chat when a chat is open, and on its own,
 * the chat's size, when one is not.
 *
 * highlight.js loads the first time a file is shown, so the map never pays for it.
 */
import { fileImageUrl, filesOpenInEditor } from '../game/api.js'
import { LinkPanel } from './link-panel.js'
import { renderMarkdown } from './markdown.js'

/** Past this, colouring a file costs more than it is worth: it shows plain. */
const HIGHLIGHT_MAX_BYTES = 400 * 1024

const LANG = {
  go: 'go', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  php: 'php', py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp',
  cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'ini', ini: 'ini',
  tf: 'ini', hcl: 'ini', tfvars: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', sql: 'sql', xml: 'xml', html: 'xml', vue: 'xml',
  svg: 'xml', css: 'css', scss: 'scss', less: 'less', md: 'markdown', graphql: 'graphql', gql: 'graphql', diff: 'diff',
  lua: 'lua', r: 'r', proto: 'protobuf', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', j2: 'django',
}

/** The highlight.js language for a path, or '' for plain text. */
export function langOf(file) {
  const base = file.split('/').pop().toLowerCase()
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  if (base === 'jenkinsfile') return 'groovy'
  return LANG[base.includes('.') ? base.split('.').pop() : ''] || ''
}

let hljs = null
const loadHighlighter = () =>
  (hljs ||= Promise.all([import('highlight.js/lib/common'), import('highlight.js/styles/github-dark.css')]).then(([m]) => m.default))

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text != null) e.textContent = text
  return e
}

/** Code with a gutter of line numbers, `line` marked. Colour arrives a moment later. */
function codeView(file, line) {
  const text = file.text.replace(/\n$/, '')
  const count = text.split('\n').length
  const wrap = el('div', 'file-code')
  wrap.dataset.path = `${file.repo}/${file.path}`
  wrap.dataset.lang = langOf(file.path)
  const gutter = el('div', 'file-gutter')
  gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n')
  const pre = el('pre')
  const code = el('code', 'hljs', text)
  pre.append(code)
  wrap.append(gutter, pre)
  if (line) {
    const mark = el('div', 'file-line-mark')
    mark.style.top = `calc(${line - 1} * var(--code-line) + var(--code-pad))`
    wrap.append(mark)
  }
  const lang = langOf(file.path)
  if (lang && file.size <= HIGHLIGHT_MAX_BYTES) {
    loadHighlighter()
      .then((h) => {
        if (!h.getLanguage(lang)) return
        // highlight.js escapes the source; what it returns is its own spans around text.
        code.innerHTML = h.highlight(text, { language: lang, ignoreIllegals: true }).value
      })
      .catch(() => {})
  }
  return wrap
}

/** The body for one file: code, rendered markdown, an image, or why it cannot be shown. */
export function renderFile(file, { line = 0 } = {}) {
  if (file.kind === 'image') {
    const box = el('div', 'file-image')
    box.append(Object.assign(el('img'), { src: fileImageUrl(file.repo, file.path), alt: file.path }))
    return box
  }
  if (file.kind !== 'text') {
    return el('div', 'link-blocked', file.kind === 'large' ? 'Too big to show here. Open it in VS Code.' : 'A binary file: nothing to read here.')
  }
  if (/\.(md|markdown)$/i.test(file.path) && !line) {
    const box = el('div', 'file-md')
    const toggle = el('button', 'btn ghost file-source', 'Source')
    const md = el('div', 'md')
    md.append(renderMarkdown(file.text.replace(/<!--[\s\S]*?-->\s*/g, '')))
    let code = null
    toggle.addEventListener('click', () => {
      code ||= codeView(file, 0)
      const showing = md.isConnected
      ;(showing ? md : code).replaceWith(showing ? code : md)
      toggle.textContent = showing ? 'Rendered' : 'Source'
    })
    box.append(toggle, md)
    return box
  }
  return codeView(file, line)
}

/** Scroll the panel's body so the marked line sits a third of the way down. */
export function scrollToLine(body, line) {
  const mark = body.querySelector('.file-line-mark')
  if (!mark || !line) return
  requestAnimationFrame(() => (body.scrollTop = Math.max(0, mark.offsetTop - body.clientHeight / 3)))
}

/**
 * A selection inside a code view, as the chat should quote it: where it is, `repo/path:12-18`,
 * and the lines in a fence. Null when the selection is not in code.
 */
export function codeQuote(sel) {
  if (!sel?.rangeCount) return null
  const range = sel.getRangeAt(0)
  const at = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.file-code pre code')
  const code = at(range.startContainer)
  if (!code || code !== at(range.endContainer)) return null
  const before = document.createRange()
  before.setStart(code, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const first = before.toString().split('\n').length
  const text = sel.toString().replace(/\n$/, '')
  const last = first + text.split('\n').length - 1
  const wrap = code.closest('.file-code')
  const where = `${wrap.dataset.path}:${first === last ? first : `${first}-${last}`}`
  return `\`${where}\`\n\`\`\`${wrap.dataset.lang || ''}\n${text}\n\`\`\`\n`
}

/** The buttons under a file: copy its path, open it in VS Code at the line. */
export function fileActions(file, line) {
  const foot = el('div', 'file-actions')
  const copy = el('button', 'btn', 'Copy path')
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(file.abs).then(() => {
      copy.textContent = 'Copied'
      setTimeout(() => (copy.textContent = 'Copy path'), 1200)
    })
  })
  const code = el('button', 'btn', 'Open in VS Code')
  code.addEventListener('click', () => filesOpenInEditor(file.repo, file.path, line).catch(() => {}))
  foot.append(copy, code)
  if (file.kind === 'text') foot.append(el('span', 'file-hint', 'Select lines to quote them into the chat'))
  return foot
}

/**
 * The viewer when no chat is open: the same panel the chat opens links in, on its own in the
 * middle of the screen.
 */
export class FileView {
  constructor(parent) {
    this.el = el('div', 'chat file-view')
    parent.append(this.el)
    this.panel = new LinkPanel(this.el, { onClose: () => this.el.classList.remove('open'), sizeKey: 'bot-crossing.file-size' })
    this.el.addEventListener('click', (e) => e.target === this.el && this.close())
  }

  get isOpen() {
    return this.el.classList.contains('open')
  }

  show(file, line, repo) {
    this.el.classList.add('open')
    this.panel.showFile(file, line, repo)
  }

  close() {
    this.panel.close()
  }
}
