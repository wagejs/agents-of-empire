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

- Anything that lets a page or process **other than the colony on this machine** reach the chat,
  approval, file or orchestration endpoints. Chat is meant to answer loopback requests only, even
  when `AGENTS_OF_EMPIRE_HOST` puts the rest of the colony on the network.
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

## Supported versions

Only the latest commit on `main` gets fixes.
