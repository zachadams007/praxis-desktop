# praxis-browser - sovereign browser sidecar

A long-lived Node process that owns **one persistent, headed Chromium** and drives it on Praxis' behalf: opening sites, reading pages and filling forms. The Rust core (`src-tauri/src/sovereign.rs`) spawns this sidecar and talks to it over a **line-delimited JSON** protocol on `stdin`/`stdout`.

It acts for level IV of the trust dial (Sovereign, see `src/shared/autonomyPolicy.ts`). The **planning** (what to click/type toward a goal) lives in Rust and calls an LLM; this sidecar is a dumb, deterministic executor. Irreversible actions are gated by the Rust veto layer - this sidecar never decides to submit anything on its own.

## One-time setup

```bash
cd praxis-browser
npm install
npx playwright install chromium
```

`npm install` pulls Playwright; `npx playwright install chromium` downloads the actual browser binary (Playwright ships the driver, not the browser). Both are one-time.

## Persistent profile

Chromium runs with `user-data-dir = %LOCALAPPDATA%\Praxis\browser-profile`. That means:

- Cookies, logins, and 2FA "remember this device" **persist across runs**. Log into a site by hand once (or let Praxis do it), and the session sticks.
- A CAPTCHA / anti-bot wall becomes a **human-takeover** step: the window is real and headed, so the owner can solve it in place and the run continues.

## Protocol

Each request is one JSON object on its own line on `stdin`:

```json
{ "id": 7, "cmd": "navigate", "url": "https://example.com" }
```

Each response is one JSON object on its own line on `stdout`:

```json
{ "id": 7, "ok": true,  "result": { "url": "https://example.com/", "title": "Example" } }
{ "id": 7, "ok": false, "error": "navigate requires url" }
```

Diagnostics go to **stderr only**, so `stdout` stays a clean one-response-per-request stream.

### Commands

| cmd          | args                       | result                                            |
| ------------ | -------------------------- | ------------------------------------------------- |
| `navigate`   | `url`                      | `{ url, title }`                                  |
| `fill`       | `selector`, `value`        | `{ selector }` - types a value into a field       |
| `click`      | `selector`                 | `{ selector }`                                    |
| `type`       | `text`                     | `{ text }` - types at the current focus           |
| `press`      | `key` (e.g. `"Enter"`)     | `{ key }`                                         |
| `read`       | - | `{ url, title, text, snapshot }` (a11y + text)    |
| `screenshot` | `full?` (bool)             | `{ base64 }` - PNG, base64                         |
| `status`     | - | `{ ready, url, title, profileDir }`               |
| `ping`       | - | `{ pong: true }`                                  |
| `shutdown`   | - | `{ bye: true }`, then the process exits           |

On boot the sidecar emits one unsolicited `{ "id": 0, "ok": true, "result": { "ready": true, "event": "boot", ... } }` line so Rust knows it is alive.

### `read` snapshot shape

`snapshot` is an array of the visible interactable elements (links, buttons, inputs, textareas, selects, ARIA widgets) - each `{ tag, role, type, name, selector }`. The planner reuses `selector` in follow-up `fill`/`click` commands. `text` is the page's visible text, capped at ~8k chars.

## Security note

The only place a password appears is as the `value` of a `fill` command sent **from Rust**. It is never logged, never echoed, and never leaves this process. The planning LLM sees the page snapshot and the goal - **never the raw credential**.

## Running standalone (debugging)

```bash
node index.mjs
# then type a line and press Enter:
{ "id": 1, "cmd": "navigate", "url": "https://example.com" }
{ "id": 2, "cmd": "read" }
```
