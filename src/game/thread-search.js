/** The search panel's matcher, kept apart from the DOM so it can be tested on its own. */

/** Each word must appear somewhere in the row, so `bot chat` finds "chat popup" in agents-of-empire. */
export function matches(row, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const { thread: t, statusLabel } = row
  const hay = [t.title, t.preview, t.project, t.projectPath, t.cwd, t.gitBranch, t.worktree, t.harnessName, t.model, statusLabel]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}
