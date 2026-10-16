/**
 * Mirrors the page's own browser storage to the server, so the desktop app (a different browser
 * profile) opens with the chat modes, sizes, open chat and last plan the browser tab had. The app's
 * preload writes the mirror back into storage before any page script runs.
 *
 * Whoever changed something last wins. The first browser tab to find the mirror empty fills it,
 * so the setup you already have seeds the app.
 */
const OWN_KEY = /^bot-?crossing\./

function snapshot() {
  const pick = (store) => {
    const out = {}
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)
        if (OWN_KEY.test(k)) out[k] = store.getItem(k)
      }
    } catch {
      /* storage blocked: nothing to mirror */
    }
    return out
  }
  return { local: pick(localStorage), session: pick(sessionStorage) }
}

const push = (body, keepalive = false) =>
  fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive }).catch(() => {})

export async function mirrorStorage() {
  let last = JSON.stringify(snapshot())
  const mirror = await fetch('/api/storage').then((r) => r.json()).catch(() => null)
  // Only a browser tab seeds it: the app starting blank must not shadow the setup you have.
  if (!window.botCrossingApp && mirror && !Object.keys(mirror.local || {}).length) push(last)
  // ponytail: a 2s poll instead of wrapping every setItem; storage here changes a few times a minute.
  const tick = (keepalive) => {
    const now = JSON.stringify(snapshot())
    if (now !== last) push((last = now), keepalive)
  }
  setInterval(tick, 2000)
  addEventListener('pagehide', () => tick(true))
}
