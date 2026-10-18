# Security

Agents of Empire runs on your own machine and drives your own Claude Code login. It can start
sessions, send messages to them, and approve the commands they ask to run. A bug here can
therefore act with your permissions, so please report security problems privately.

## Reporting a vulnerability

Use **[Report a vulnerability](https://github.com/wagejs/agents-of-empire/security/advisories/new)**
on this repository's Security tab. Please do not open a public issue for it.

Include what you did, what happened, and what you expected. A minimal reproduction helps most.
This is a personal project with no guaranteed response time, but security reports are read
before anything else.

## What counts

Things that are in scope:

- Anything that lets a **web page you visit** (any other site, or a dev server on another local
  port) reach the chat, approval, file or orchestration endpoints. Every change is meant to come
  from the colony's own page on this machine, even when `AGENTS_OF_EMPIRE_HOST` puts the colony
  on the network for other devices to look at.
- A way to make the colony **approve, run or push** something you did not approve on the page.
- Reading files **outside the folders** the file finder and plans are configured to use.
- Writing to a harness's own data. The colony is meant to be read-only towards every harness.
- Cross-site scripting through thread titles, transcripts, markdown or file contents.

Not in scope:

- Setting `AGENTS_OF_EMPIRE_HOST` to a public interface and exposing the colony to the internet.
  It is built to listen on `127.0.0.1`.
- Choosing **Allow all** or **Always allow** and then disliking what Claude did with it.
- Vulnerabilities in Claude Code, the other harnesses, or their models. Report those to their
  vendors.

## How it protects you

- The server binds `127.0.0.1`. It refuses a `Host` it does not know (DNS rebinding), an
  `Origin` that is not its own exact host and port, and a browser's `Sec-Fetch-Site` that says
  cross-site.
- Every request that changes something must be JSON, so a plain form or `no-cors` request from
  another page never reaches a handler, and must come from this machine.
- The page ships with a Content Security Policy and renders transcripts, markdown and file
  contents as text, never as HTML.
- Link previews never fetch private or loopback addresses. Markdown opens only from the thread's
  folder, `~/.claude`, and your repos folder.
- Orchestration sessions write only inside their own worktree, never rebase or force-push, and
  wait for you before pushes, PRs, risky commands and your own `ask` rules.
- Its own files (`data/`, `~/.claude/.store/`) are created readable by you alone.

## Known limits

- **One person per machine.** Any program already running as you, or anyone else logged in to
  the same machine, can call the local server as the page does. There is no login on it. If you
  share a machine, do not run the colony there.
- **Allow all means it.** A chat or a repo session in Allow all runs commands as you. The command
  checks for orchestration sessions match command text, so a script that pushes slips past them;
  turn on Claude Code's sandbox if that is not enough.
- **Project settings come along.** A chat started in a folder loads that folder's
  `.claude/settings.json`, hooks included, as Claude Code itself does. Only start chats in folders
  you trust.
- **The desktop browser panel** keeps its own signed-in session (`persist:links`). Clear it from
  the app's data folder if you hand the machine to someone else.

## Supported versions

Only the latest commit on `main` gets fixes.
