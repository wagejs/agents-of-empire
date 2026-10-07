# agents-world

A fork of [Bot Crossing](https://github.com/jarrenrocks/bot-crossing) by Jarren Rocks
([@jarrenrocks](https://github.com/jarrenrocks)). Bot Crossing shows each coding-agent thread on
your computer as a bot in a 3D colony. This fork adds chat and thread control to the colony.

Thank you, Jarren, for the colony, the bots and the harness adapters. For all other details
(the harnesses, the controls, the world, the design and the art), refer to the original project
at [github.com/jarrenrocks/bot-crossing](https://github.com/jarrenrocks/bot-crossing) and
[botcrossing.com](https://botcrossing.com).

## Run it

You need:

- Node.js 22.13 or later.
- The [Claude Code](https://claude.com/claude-code) CLI, with a login. Chat uses it.

Do these steps:

1. Install the packages and start the dev server:

   ```bash
   npm install && npm run dev
   ```

2. Open http://localhost:5274 in your browser.

Other commands:

- `npm start`: build the app and serve it. Use this to chat while you change the code.
- `npm test`: run the tests.

The server listens only on `127.0.0.1`. Chat accepts requests only from this computer.

## What this fork adds

### Chat with a thread

- Select a Claude Code bot. Click **Chat** or push Enter. The chat popup opens.
- The popup shows the last turns of the thread.
- The reply shows word by word. The popup shows markdown: headings, lists, code, tables and links.
- You can select and copy text in the popup.
- Each tool call shows on one line. Click the line to see the full command.
- Type `/` to see the commands and skills for the thread.
- Drag the corner of the popup to change its size. Each thread keeps its size.

### Approvals, questions and modes

- When Claude asks to use a tool, the popup shows **Allow**, **Always allow** and **Deny**.
- **Always allow** writes the rule to `.claude/settings.local.json` in the project.
- When Claude asks a question, the popup shows the options. Select an option, or type a different answer.
- Select a permission mode for each thread: **Ask**, **Plan**, **Auto-edit**, **Allow all** or **Deny**.
- A change of mode applies to the current reply immediately.

### Replies that continue

- The reply runs on the server, not in the page.
- If you close the popup, open a different thread or reload the page, the reply continues.
- After a reload, the popup opens again at the same thread.
- Background subagents send their results to the same reply.
- You can send a message while Claude works. The message waits in a queue.
- When the reply stops, Claude gets all queued messages as one turn.
- Click **Stop** to stop the reply. The queued messages go immediately.

### Threads

- Click **New conversation** to start a Claude Code thread from the page. Select the repo, or type a folder.
- Click the title on the thread card to rename the thread. Claude Code gets the new name too.
- Push ⌥N in the popup to go to the next thread that needs you.
- Push `/` on the map to search all threads. Archive idle threads, or revive archived threads.
- Subagents show as small teal bots. They have no actions.

### Status and settings

- The **working** status uses the busy flag that Claude Code writes. An idle thread does not show as working.
- Long transcripts show their correct title.
- Click **Save as Mine** to keep your quality settings. Click **Mine** to use them again.

### Safety

- Chat accepts requests only from this computer.
- Chat uses your own `claude` CLI and its login. Nothing goes to a different service.

## Licence

This fork uses the [MIT licence](LICENSE), the same as the original project.

- Copyright © 2026 Jarren Rocks, for Bot Crossing.
- Copyright © 2026 Muhammad Wage Juli Saputra, for the changes in this fork.

The name **Bot Crossing** and new character designs stay with Jarren Rocks. Refer to
[TRADEMARKS.md](TRADEMARKS.md). This fork uses a different name for this reason.

The 3D art in `public/assets/` is CC0, by Kay Lousberg and Kenney. Refer to
[CREDITS.md](public/assets/CREDITS.md). The status icons are
[Material Design Icons](https://pictogrammers.com/library/mdi/), under the Apache-2.0 licence.

This fork is not affiliated with Anthropic, OpenAI, Google or the other harness vendors.
