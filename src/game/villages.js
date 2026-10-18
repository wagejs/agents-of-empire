/**
 * Villages: one world split three ways.
 *
 * Misc is the colony as it always was, one plot per repo, filled by the scan. Sprint and
 * Side-project hold hexes you made by hand (a ticket, a side project), and a thread lands in one
 * only because you put it there. This file decides where every thread goes, and nothing else.
 *
 * Pure and browser-free, like merge-state.js, so the rules run under bare node.
 */
export const VILLAGES = ['sprint', 'side', 'misc']
export const VILLAGE_LABEL = { sprint: 'Sprint', side: 'Side-project', misc: 'Misc' }

/** A hex's plot id. Repo names never contain a colon, so this cannot collide with a Misc plot. */
export const hexPlotId = (hexId) => `hex:${hexId}`
export const hexIdOfPlot = (plotId) => (typeof plotId === 'string' && plotId.startsWith('hex:') ? plotId.slice(4) : null)

/**
 * Every plot the colony should draw, and which threads stand on each.
 *
 * A thread is off the map when it is archived, when its hex is archived, or (unplaced only)
 * when its repo is hidden. Hiding a repo is a Misc tidy-up: a thread you placed in a hex was a
 * deliberate choice, and stays. A placement to a hex that no longer exists falls back to Misc,
 * so stale data never loses a thread. Every live hex is a plot even with nobody on it — a ticket
 * you have not touched yet still needs somewhere to be.
 *
 * @returns {{ groups: Map<string, { id, village, name, hexId, threads }>, onMap: Set<string> }}
 */
export function placeThreads({ threads = [], archivedIds = [], hiddenProjects = [], hexes = {}, placements = {} }) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  const groups = new Map()
  const onMap = new Set()

  // Hexes first, so an empty one still gets its plot.
  for (const [hexId, hex] of Object.entries(hexes || {})) {
    if (!hex || hex.archived) continue
    const id = hexPlotId(hexId)
    groups.set(id, { id, village: hex.village, name: hex.name, hexId, threads: [] })
  }

  // A run's repo sessions go wherever its orchestrator went, and a subagent wherever its parent
  // did — unless one was placed on its own.
  const orchestratorOf = new Map()
  for (const t of threads) if (t.share?.role === 'orchestrator' && t.share.plan) orchestratorOf.set(t.share.plan, t.id)
  // A thread's own placement wins, `misc` included: that is how a follower is kept in Misc.
  const placementOf = (thread) =>
    placements?.[thread.id] ||
    (thread.parentId && placements?.[thread.parentId]) ||
    (thread.share?.role === 'child' && placements?.[orchestratorOf.get(thread.share.plan)]) ||
    ''

  for (const thread of threads) {
    if (thread.archived || archived.has(thread.id)) continue
    const hexId = placementOf(thread)
    const hex = hexId ? hexes?.[hexId] : null
    if (hex) {
      if (hex.archived) continue
      groups.get(hexPlotId(hexId)).threads.push(thread)
      onMap.add(thread.id)
      continue
    }
    const name = thread.project || 'unknown'
    if (hidden.has(name)) continue
    if (!groups.has(name)) groups.set(name, { id: name, village: 'misc', name, hexId: null, threads: [] })
    groups.get(name).threads.push(thread)
    onMap.add(thread.id)
  }
  return { groups, onMap }
}
