/**
 * Drag a popup's bottom-right corner to resize it, and it opens at that size next time. Each
 * popup keeps its own size under its own `key`; the browser draws the handle (CSS `resize`, see
 * `.resizable`) and writes the size inline, which is what is saved.
 */
export function rememberSize(el, key) {
  el.classList.add('resizable')
  try {
    const { width, height } = JSON.parse(localStorage.getItem(key)) || {}
    if (width && height) Object.assign(el.style, { width, height })
  } catch {
    /* no size kept: the stylesheet's */
  }
  new ResizeObserver(() => {
    const { width, height } = el.style
    if (!width || !height) return
    try {
      localStorage.setItem(key, JSON.stringify({ width, height }))
    } catch {
      /* kept until the reload */
    }
  }).observe(el)
}
