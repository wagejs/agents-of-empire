/**
 * Markdown for chat replies, built as DOM nodes and never as an HTML string.
 *
 * A reply can quote anything Claude read, such as a web page or a file somebody else wrote, and
 * the page it lands in can approve tool calls. Markup that reached `innerHTML` could click Allow
 * for itself. Here the parser emits plain objects whose tags come from this file, text only ever
 * becomes text nodes, and a link keeps its href only when it is http(s) or mailto. Script cannot
 * get in because nothing that could carry it is ever built, not because a filter removes it.
 *
 * ponytail: the subset Claude actually writes. That is headings, paragraphs, nested lists, code
 * fences, quotes, tables and rules, plus inline code, bold, italic, strike and links. Reference
 * links, backslash escapes and HTML render as plain text. Swap in marked + DOMPurify if that
 * ceiling starts to show.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i

const INLINE = new RegExp(
  [
    /`([^`\n]+)`/, // 1 code
    /\*\*(?=\S)([^\n]*?\S)\*\*/, // 2 bold
    /(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/, // 3 bold
    /~~(?=\S)([^\n]*?\S)~~/, // 4 strike
    /(?<!\w)\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\w)/, // 5 italic
    /(?<!\w)_([^\s_](?:[^_\n]*[^\s_])?)_(?!\w)/, // 6 italic
    /\[([^\]\n]+)\]\(([^)\s]+)\)/, // 7 label, 8 url
    /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/, // 9 bare url
    /(?<![\w/.~])((?:~|\/[\w@.+-]+)(?:\/[\w@.+-]+)*\/[\w@+-][\w@.+-]*\.[a-z]\w{0,7}(?::\d+(?:-\d+)?)?)(?![\w/])/, // 10 bare absolute or ~/ file path
  ]
    .map((r) => r.source)
    .join('|'),
  'g'
)

const node = (tag, children, attrs) => ({ tag, children, ...attrs })
const leading = (line) => line.length - line.trimStart().length
const isTableStart = (lines, i) =>
  lines[i].includes('|') && (lines[i + 1] || '').includes('|') && TABLE_SEP.test(lines[i + 1])
const startsBlock = (lines, i) =>
  [FENCE, HEADING, RULE, QUOTE, ITEM].some((r) => r.test(lines[i])) || isTableStart(lines, i)

/** Markdown → a tree of `{ tag, children, href?, start? }` and strings. No DOM involved. */
export function parseMarkdown(src) {
  return blocks(String(src).replace(/\r\n?/g, '\n').split('\n'))
}

/** The parsed tree as nodes, ready to append. Only fixed tags, text, and checked attributes. */
export function renderMarkdown(src) {
  const fragment = document.createDocumentFragment()
  fragment.append(...parseMarkdown(src).map(toDom))
  return fragment
}

function toDom(n) {
  if (typeof n === 'string') return document.createTextNode(n)
  const el = document.createElement(n.tag)
  if (n.href) {
    el.href = n.href
    el.target = '_blank'
    el.rel = 'noopener noreferrer'
  }
  if (n.start) el.start = n.start
  el.append(...n.children.map(toDom))
  return el
}

function blocks(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m
    if (!line.trim()) {
      i++
    } else if ((m = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`)
      const body = []
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i])
      i++ // past the closing fence, or the end while the reply is still streaming in
      out.push(node('pre', [node('code', [body.join('\n')])]))
    } else if ((m = HEADING.exec(line))) {
      out.push(node(`h${m[1].length}`, inline(m[2])))
      i++
    } else if (RULE.test(line)) {
      out.push(node('hr', []))
      i++
    } else if (QUOTE.test(line)) {
      const body = []
      for (; i < lines.length && (m = QUOTE.exec(lines[i])); i++) body.push(m[1])
      out.push(node('blockquote', blocks(body)))
    } else if (isTableStart(lines, i)) {
      const head = cells(line)
      const rows = []
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]))
      out.push(node('table', [node('thead', [row('th', head)]), node('tbody', rows.map((r) => row('td', r)))]))
    } else if (ITEM.test(line)) {
      i = list(lines, i, out)
    } else {
      const para = []
      for (; i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines, i)); i++) para.push(lines[i])
      out.push(node('p', inline(para.join('\n'))))
    }
  }
  return out
}

const cells = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => inline(cell.trim()))
const row = (tag, list) => node('tr', list.map((c) => node(tag, c)))

/**
 * One list, and every line that belongs to it. Lines indented past the marker belong to the item
 * above them and are parsed again as blocks, which is all a nested list is.
 */
function list(lines, start, out) {
  const [, pad, marker] = ITEM.exec(lines[start])
  const indent = pad.length
  const ordered = /\d/.test(marker)
  const items = []
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    const m = ITEM.exec(line)
    if (m && m[1].length === indent) {
      if (/\d/.test(m[2]) !== ordered) break
      items.push([m[3]])
    } else if (!line.trim()) {
      // A blank line stays in the list only when the list carries on after it.
      const next = lines[i + 1] || ''
      if (!next.trim() || leading(next) < indent || (leading(next) === indent && !ITEM.test(next))) break
      items.at(-1).push('')
    } else if (leading(line) > indent) {
      items.at(-1).push(line)
    } else {
      break
    }
  }
  const first = ordered ? Number.parseInt(marker, 10) : 1
  out.push(node(ordered ? 'ol' : 'ul', items.map(item), first !== 1 ? { start: first } : {}))
  return i
}

function item([head, ...rest]) {
  if (!rest.some((l) => l.trim())) return node('li', inline(head))
  const depth = Math.min(...rest.filter((l) => l.trim()).map(leading))
  return node('li', blocks([head, ...rest.map((l) => l.slice(Math.min(depth, leading(l))))]))
}

function inline(text) {
  const out = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(span(m))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function span([all, code, bold, bold2, strike, em, em2, label, url, bare, file]) {
  if (code !== undefined) return node('code', [code])
  // A path Claude wrote bare in prose (`The plan is at /abs/plan.md`) reads as code, so it opens and copies.
  if (file) return node('code', [file])
  if (bold ?? bold2) return node('strong', inline(bold ?? bold2))
  if (strike) return node('del', inline(strike))
  if (em ?? em2) return node('em', inline(em ?? em2))
  if (label) {
    if (SAFE_URL.test(url)) return node('a', inline(label), { href: url })
    // A link to a file in the repo (`[api.mjs:25](server/api.mjs:25)`) shows its path, as code.
    return /^[^\s:]+(?::\d+(?:-\d+)?)?$/.test(url) && !/^[a-z][\w+.-]*:/i.test(url) ? node('code', [url]) : all
  }
  return node('a', [bare], { href: bare })
}
