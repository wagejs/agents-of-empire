/**
 * One-time move of the keys this page stored under its old name (`bot-crossing.*`,
 * `botcrossing.*`) to `agents-of-empire.*`. Imported first, so every reader sees the new keys.
 * A key already under the new name wins. Delete this file once nobody has the old keys.
 */
const OLD = /^bot-?crossing\./

export function migrate(store) {
  for (const k of Object.keys(store)) {
    if (!OLD.test(k)) continue
    const next = k.replace(OLD, 'agents-of-empire.')
    if (store.getItem(next) === null) store.setItem(next, store.getItem(k))
    store.removeItem(k)
  }
}

try {
  migrate(localStorage)
  migrate(sessionStorage)
} catch {
  /* storage blocked: nothing to move */
}
