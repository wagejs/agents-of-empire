/** The ⌘P palette's matching, kept apart from the DOM so it can be tested on its own. */

/**
 * How well `query` fuzzy-matches `text` (both lower case), and where: `{ score, at }`, or null
 * when its letters are not all there in order. Letters landing in the file name, at the start
 * of a word, or next to each other score higher; a shorter path wins a tie.
 */
export function fuzzy(query, text, nameFrom = text.lastIndexOf('/') + 1) {
  const q = query.replace(/\s+/g, '')
  if (!q) return { score: 0, at: [] }
  const from = (start) => {
    const at = []
    for (let i = start, k = 0; k < q.length; k++, i++) {
      i = text.indexOf(q[k], i)
      if (i === -1) return null
      at.push(i)
    }
    return at
  }
  // All in the file name beats spread along the path, as `hand` means handler.go, not h/a/n/d.
  let at = from(nameFrom)
  const inName = Boolean(at)
  at ||= from(0)
  if (!at) return null
  let score = inName ? 10 : 0
  const name = text.slice(nameFrom)
  if (name.startsWith(q)) score += 12
  else if (text.includes(q)) score += 8
  at.forEach((i, k) => {
    score += 1
    if (k && i === at[k - 1] + 1) score += 4
    if (i === 0 || '/_-. '.includes(text[i - 1])) score += 3
  })
  return { score: score - text.length / 100, at }
}

/** `handler.go:120` → `{ query: 'handler.go', line: 120 }`; a path with no line keeps line 0. */
export function splitLine(q) {
  const m = /^(.*?):(\d+)$/.exec(q)
  return m ? { query: m[1], line: Number(m[2]) } : { query: q, line: 0 }
}
