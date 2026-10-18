# Feature details

Everything this fork adds on top of [Bot Crossing](https://github.com/jarrenrocks/bot-crossing),
down to the small touches. The [README](../README.md) has the overview; this is the full list.

- [Chat popup](#chat-popup)
- [Chat history](#chat-history)
- [Approvals, questions and modes](#approvals-questions-and-modes)
- [Plan mode](#plan-mode)
- [Beside the chat: links, files and documents](#beside-the-chat-links-files-and-documents)
- [Quoting](#quoting)
- [File finder (⌘P)](#file-finder-p)
- [Threads on the map](#threads-on-the-map)
- [Villages](#villages)
- [Pull requests](#pull-requests)
- [Search](#search)
- [Orchestration](#orchestration)
- [Fresh loop](#fresh-loop)
- [Desktop app](#desktop-app)
- [Medieval planet](#medieval-planet)
- [Sidebar, help and settings](#sidebar-help-and-settings)

---

## Chat popup

- **Open any Claude Code thread from the map**: select a bot and press `Enter`, or click **Chat**
  on its card.
- **Replies stream in** token by token and render as markdown: headings, lists, tables, code
  blocks and links.
- **Tool calls show on one line each**, such as `Read · src/app.ts`. Click a line to see the full
  command.
- **The header names the repo** in that repo's colour, above the thread title, so you always know
  where you landed when jumping between chats.
- **The header shows the model** replying, and each thread can switch between Opus, Sonnet and
  Haiku.
- **`/` opens the command menu**, with the commands and skills available in that thread's folder,
  exactly as Claude Code's own menu lists them.
- **Replies keep running on the server.** Close the popup, switch threads or reload the page, and
  the reply continues; reopening the thread picks it up live.
- **Messages queue while Claude works.** Anything typed mid-reply goes straight into the session.
  The "waiting" label clears when Claude Code takes it in, and the reply lands under your message
  as a new block.
- **Stop** ends the reply and sends any queued messages at once.
- **Background subagents report into the same reply**, and subagents started from the page spawn
  on the map as small bots.
- **Rename a thread** by clicking its title on the card. Claude Code gets the new name too, and a
  thread renamed twice shows the latest name.
- **`⌥N` (Alt+N) jumps to the next thread that needs you**, from inside the chat. The header shows
  how many are waiting.
- **Copy buttons** sit beside links and paths in replies.
- **Each popup remembers its own size.** Drag the corner; every popup keeps its size separately.
- **Scheduled sessions stay alive.** A session with a schedule (`CronCreate`, `/loop`) is kept
  running between ticks, so long-running skills ask their questions in the popup instead of a
  terminal. The chat shows the session's schedule as it changes.

## Chat history

- **Opens on your last 10 turns**, reading back past large tool output rather than a fixed byte
  window, so a long transcript never hides the conversation.
- **Scroll to the top to load the 10 turns before**, anchored on the oldest message shown, all
  the way back to the thread's first message.
- **Long transcripts show their real title**, not the first prompt.
- **A reply you've seen stays seen**, even when Claude Code rewrites its transcript's bookkeeping
  on reopen.

## Approvals, questions and modes

- **Tool approvals in the page**: **Allow**, **Always allow** and **Deny**. **Always allow**
  writes the rule to the project's `.claude/settings.local.json`. An ask's reason shows on its card.
- **Claude's own questions** show their options in place. Pick one, or type your own answer.
  Several questions page one at a time (**Prev** / **Next**, **Submit all**).
- **Permission mode per thread**: **Ask**, **Plan**, **Auto-edit**, **Allow all** and **Deny**.
- **A mode change applies at once**, including to approvals already waiting.
- **Allow all, Auto-edit and Deny hold.** Anything Claude Code still asks under them is answered
  by the mode, with a note in the chat.

## Plan mode

- **A plan opens beside the chat as a document** and waits for you: approve with auto-accept edits,
  approve and ask before edits, or keep planning with feedback.
- **The bot needs you while a plan waits**, and opening its chat brings the plan up.
- **Switching modes never approves a plan** by accident.

## Beside the chat: links, files and documents

- **Links open in a panel beside the chat** rather than a new tab. `⌘`/`Ctrl`-click still opens a
  tab.
- **GitHub pull requests and issues** render in the panel from your own `gh` login. Other pages are
  framed when the site allows it.
- **In the desktop app the panel is a real browser**, for sites a tab cannot frame (GitHub, Jira).
  Sign in once and stay signed in; **Open ↗** hands the page to your own browser.
- **Markdown files open rendered**: a `.md` file Claude wrote, edited, read or named opens beside
  the chat.
- **Code paths in a reply open in the file viewer**, found by the end of their path when Claude
  wrote only part of it.
- **The side panel has its own size**, separate from the chat, and its text is selectable.

## Quoting

- **Select text in a reply** to quote it into the message box.
- **Select text in the side panel** (a plan, a markdown file, a PR) to quote it the same way.
- **Select lines in the file viewer** to quote them as `path:lines` plus a fenced code block.

## File finder (⌘P)

- **`⌘P` / `Ctrl+P` opens a quick open** over every repo in `AGENTS_OF_EMPIRE_FILES_ROOT`.
  Worktrees and git-ignored files are left out.
- **Fuzzy file search**, `@repo` to narrow to one repo, `:line` to jump to a line, and `/text` to
  search inside files with `git grep`.
- **Files open read-only** with line numbers and syntax colours. With a chat open they open beside
  it; otherwise on their own.
- **Copy path**, **Open in VS Code** and fullscreen from the viewer. The viewer alone can take the
  whole window.
- **Recent files and the last scope** are remembered.

## Threads on the map

- **New chat anywhere**: `C` or the **+** button. It starts in the selected repo, or in your home
  folder when none is selected, and can move to any repo (or any folder) before the first message.
- **Working status follows Claude Code's busy flag**, so an idle thread never shows as working.
- **A terminal thread whose last word is a reply asks for you** for a day, even after its process
  has ended.
- **Hover a quiet bot** and a small card appears by the cursor after a short rest: title, status,
  branch and the last thing said.
- **The bot card shows the branch** and the model.
- **Subagents are smaller bots**, teal on the space planets and Minions on Medieval. They have no
  actions.
- **The harness's own folder** (`.claude` and similar) always holds the centre plot.
- **Walls and scaffolding are obstacles**: builders route round them and never stand inside a wall
  or settle short of their spot.

## Villages

- **Three villages, three islands**: Misc is the colony as it always was, one plot per repo.
  Sprint and Side-project are islands of their own out at sea, joined to Misc by a plank bridge
  the crew walk across. Each island grows from its own middle the way Misc does, and moves out
  whole when Misc grows into its water.
- **Hexes you make by hand**: type a ticket or a side project into the Sprint or Side-project
  section of the sidebar and it stands on the map at once, empty until you put work there.
- **Move a thread into a hex** from its card's **Move to** picker, or pick the village and hex
  when you start a **New chat**. A thread you move keeps its place across branches and restarts.
- **Sessions follow**: move an orchestrator and its repo sessions go with it; a subagent goes
  wherever its parent is. Move one on its own and it stays where you put it.
- **Archive a hex** when the ticket ships: it folds away with its threads, and **Restore** brings
  it back to the same spot. Archiving a hex with work still running asks first.
- **Fly to a village** with the target button beside its name in the sidebar.
- Hiding a repo only tidies Misc: threads you placed in a hex stay on the map.


- **A session's PRs show as pills** on the hover card, the bot card and the chat header, read from
  the `pr-link` lines Claude Code writes into the transcript.
- **Pills are coloured by state** on GitHub: open, approved, changes requested, draft, merged or
  closed.
- **A PR pill in the chat header opens the PR** in the panel beside the chat.

## Search

- **`/` searches every thread**, archived ones too, by title, preview, repo and branch, with every
  word required in any order.
- **Arrow keys move the highlight**; `Enter` opens the chat and flies to the bot.
- **Revive an archived thread** from the results.

## Orchestration

- **Run a plan** takes a `plan.md` path. Opus reads the whole plan into one session per repo,
  with their order, tasks for you and notes, checked against the repos it can reach.
- **A design step with no repo** counts as context when the plan lists its files.
- **The preview exercises the plan** against each repo's real code, read-only, in the fresh
  worktree the session will use: files to change, tests, risks and open questions. It's kept per
  plan, reused while the plan is unchanged, and handed to the session as its brief.
- **Pick a model per repo**: Sonnet by default, Opus selectable.
- **Fresh worktrees**: every repo session branches from a fresh fetch of the remote default branch,
  so your local checkout's branch, staleness and uncommitted changes never matter.
- **Repo sessions run Allow all inside their worktree**, under your own Claude settings: your deny
  rules still deny, and the repo's `settings.local.json` comes along.
- **Pushes, PRs, risky commands and your ask rules wait** for your **Allow** or **Deny** in the
  Orchestrations tab, and the orchestrator tells you what each one is for.
- **Force-push and rebase are always refused** inside repo sessions.
- **Earned trust**: every answer is recorded per repo. After 5 approved pushes or PRs, that repo's
  sessions push and open PRs on their own.
- **Role pins on the map**: an orange sitemap pin over the orchestrator and a violet branch pin over
  each repo session, on top of the status badge.
- **The Orchestrations tab** lists each run; a row flies to its bot and follows it.
- **Report to orchestrator**: in a repo session's chat, passes what you said to it directly on to
  the orchestrator.
- **Shared notes**: approved reports become notes in `~/.claude/.store`, never deleted (superseded
  instead), with code references that go stale when the repo moves on.
- **The plan panel** can be dragged to size and keeps it; **Start** waits for the preview.
- **From the terminal**: `npm run share -- run | status | report | resume | approve | close`.

## Fresh loop

- **A ↻ button per loop skill** in the sidebar stops every session running that skill, archives
  them, and starts it again in Allow all, named after the skill and told which session it replaces.
  State the skill keeps on disk carries over.
- **+ adds any skill** installed in `~/.claude/skills/` as a loop; **×** removes it. The list is
  saved in `data/loops.json`.
- **Only installed skills show.** With none chosen, the row holds just the **+**.

## Desktop app

- **`npm run app`** runs the colony in its own window, with the server in-process on
  `127.0.0.1:5275` (`PORT` to change it).
- **Closing the window hides it**; the colony keeps running, and the dock icon brings it back.
  `⌘Q` quits.
- **A notification and a dock badge** when a thread needs you while the window is in the
  background. Clicking it flies to the bot.
- **The browser beside the chat** (see above).
- **Shares setup with the browser tab**: chat modes, sizes, the open chat and the last plan are
  mirrored through `data/storage.json`.

## Medieval planet

- **A KayKit hex island**: grass under the plots, a ring road, a river out to the sea, and trees,
  rocks, hills and mountains on the outer tiles.
- **A walled town**: painted roads become castle walls that run into the castle, with a gatehouse
  the crew walks out through.
- **The town grows when full**: if repos need more room, the wall and everything beyond it move out
  a ring, and it never shrinks within a session.
- **Buildings grow** from scaffolding to a finished building whose colour shows the status; a long
  thread becomes a church, a windmill or a great tower.
- **Skeleton crew**: Minions for subagents, and a Rogue, Warrior or Mage for each main thread, the
  same one every time. Eyes glow in the status colour, and cloth is dyed in the repo's colour, on
  the map and on the card portrait.
- **Plain plots**: repo tiles are plain grass, so the buildings carry the colour.
- **Map editor** at `tools/map-editor.html`: paint sea, grass, road, river, trees, rocks, hills or
  mountain, with a live preview in the open game tab.

## Sidebar, help and settings

- **Toolbar in two groups** under the name: Threads (new chat, search) and View (screenshot,
  help, hide UI, settings).
- **Help sheet (`?`)** in two columns: shortcuts and status badges on one side, orchestration and
  Fresh loop on the other, sized to fit the desktop window.
- **Start on**: pick the planet the page opens on.
- **Save as Mine**: keep your quality settings and return to them with **Mine**.
- **The curvature slider** reads "Flat" at zero.
