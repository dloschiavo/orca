# Chrome MCP discipline

You may have access to one or both Chrome MCP families: `mcp__Claude_in_Chrome__*`
and `mcp__chrome-devtools__*`. Both drive the **user's real browser window on the
user's real machine**. They are not sandboxed, not ephemeral, and not yours to
churn. Misuse interrupts the user's work and triggers anti-abuse heuristics
that lock the browser out for every subsequent agent on this machine.

These are hard constraints, not suggestions. A dispatch that violates rule 1 or
rule 2 will be treated as failed regardless of what else it accomplished.

---

## STOP — FORBIDDEN TOOL CALLS

For the entire duration of this dispatch, you MUST NOT call any of the
following tools. There is no exception, no "just this once," no
"only at the end to clean up." The orchestrator owns the browser lifecycle.

Closing tabs / pages — forbidden (and the orchestrator now denies these at
the tool layer; calling them will return a tool-not-available error):

- `mcp__Claude_in_Chrome__tabs_close_mcp`
- `mcp__chrome-devtools__close_page`

Creating tabs / pages — forbidden (also denied at the tool layer):

- `mcp__Claude_in_Chrome__tabs_create_mcp`
- `mcp__chrome-devtools__new_page`

You do not need these. There is already a tab open in the user's browser.
Your only allowed path to load a URL is:

1. `list_pages` (or `list_connected_browsers` + page list) — see what's there
2. `select_page` / `tabs_context_mcp` — attach to an existing tab
3. `navigate_page` / `navigate` — change the URL of that tab in place

Spawning a second browser / disconnecting — forbidden:

- Any tool whose effect is to launch a new browser, open a second connected
  window, or "disconnect / quit / shutdown / stop" an existing browser.

Focus / window manipulation — forbidden unless the story explicitly requires it:

- `mcp__Claude_in_Chrome__resize_window`
- `mcp__chrome-devtools__resize_page`
- `mcp__chrome-devtools__emulate` (for window/viewport changes)
- Any "activate / focus / raise / foreground" operation on the window or a tab.

If you find yourself reaching for any of the above, **stop and re-read this
directive**. There is always a non-destructive alternative below.

---

## 1. NEVER steal focus

The user is actively using their machine. Every time you raise a browser
window to the foreground, you interrupt them.

- Do NOT call any tool whose effect is to focus, raise, activate, or
  foreground the browser window or a specific tab.
- When creating tabs, pass the option that keeps the tab in the background
  (e.g. `active: false`, `background: true`, or whatever the specific tool
  exposes). If the tool defaults to foreground and there is no way to
  suppress focus, prefer `navigate` / `navigate_page` on an existing
  background tab instead.
- Do not call `resize_page`, `resize_window`, or any emulation tool that
  would move/resize the user's window unless the story specifically asks
  for responsive testing.
- Do not bring DevTools to the foreground; read console + network via the
  text tools (`list_console_messages`, `get_console_message`,
  `list_network_requests`, `get_network_request`,
  `read_console_messages`, `read_network_requests`).

## 2. NEVER open and close windows — reuse ONE window via tabs

**This is the rule agents repeatedly violate. Read it twice.**

Repeatedly opening and closing browser windows (or tabs) logs you back in
from scratch each cycle. Google/Chrome's anti-abuse heuristics flag the
account for "malicious behavior" and lock the browser out — not just for
this dispatch, for every subsequent agent on this machine until the user
manually recovers. **Do not do this.**

The correct lifecycle is exactly this: **one window, lives the whole
dispatch, multiple tabs inside it, every tab stays open until the
orchestrator tears down.**

Before navigating anywhere, the very first thing you do is:

1. Call `list_connected_browsers` and/or `list_pages`. A browser is
   already connected with at least one tab — **attach to it**
   (`select_browser` / `switch_browser` / `select_page`).
2. Navigate the attached tab IN PLACE with `navigate` / `navigate_page`.
   Do not create a new tab. Do not close the current one. Reuse it for
   every URL you need to visit during this dispatch.
3. To re-check a page you already loaded, use `select_page` /
   `tabs_context_mcp` to switch to that tab and `navigate_page` to
   refresh — never close and re-open.
4. When you are done with a tab, **leave it open**. The orchestrator
   cleans up. Your "tidy up after myself" instinct is exactly the bug.

### Hard bans for the duration of the dispatch

You will not, under any circumstance:

- Call `tabs_close_mcp` or `close_page`. Not at the end. Not "to clean
  up". Not because the tab is no longer needed. Leave every tab open.
- Call any "disconnect", "quit", "shutdown", or "stop browser"
  operation. The orchestrator owns the browser lifecycle, not you.
- Open a second browser window when one is already connected.
- Open → close → open the same URL. If you need to re-check a page,
  switch to its existing tab and re-navigate in place, or read its
  current state with `take_snapshot` / `get_page_text` / `read_page`.

### If you think you have a legitimate reason to close a tab

You don't. The orchestrator handles teardown. Re-read this section.

## 3. Minimize per-action churn

Each navigation and screenshot costs the user wall-clock time and tokens.

- Batch your checks: load the page once, then read console, network,
  snapshot, and screenshot from that same loaded state.
- Prefer text-based readers (`get_page_text`, `read_page`,
  `take_snapshot`) over `take_screenshot` unless the bug is specifically
  visual. Screenshots are the most expensive verification path.
- If a page already loaded the URL you need, do not re-navigate to it.

---

Violations of rule 1 or rule 2 will get the user's browser session locked
out and break every subsequent agent on this machine. Treat these as hard
constraints, not suggestions. If you are uncertain whether an action
violates this directive, **don't take it** — read it again first.
