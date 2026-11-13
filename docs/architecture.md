# Architecture

Tailorscript is plain JavaScript modules with no bundler. `src/` is the extension exactly as Chrome loads it; the build only copies it and stamps the version. Third-party code is vendored under `src/vendor/`: acorn as published, and CodeMirror as one ES module bundle that `npm run vendor` builds with esbuild from `scripts/vendor/codemirror-entry.mjs`.

## Pieces

| Part | Files | Responsibility |
| --- | --- | --- |
| Service worker | `background/service-worker.js` | Wires Chrome's events to the modules below. Checks every message against `shared/messages.js`, runs the storage upgrade before anything else, and registers the `.user.js` redirect. |
| Library | `background/library.js`, `background/queue.js` | Every change to the script library, applied one at a time through one queue, so saves, toggles, imports and Trash operations never interleave. |
| Script bridge | `background/script-bridge.js`, `background/bridge-token.js`, `background/tab-actions.js` | What userscripts reach through messages: stored values, requests, notifications, tabs, run and error reports and menu commands. Also Run now and calls back into a script's world. |
| Update checks and diagnostics | `background/update-check.js`, `background/diagnostics.js` | The scheduled and manual update check, and the report behind **Copy diagnostics**. |
| Registration | `background/registration.js` | Turns stored scripts into `chrome.userScripts` registrations in library order: match patterns, include globs, `@require` files and the script. A regular-expression `@include` wraps the script in an address check on its first line, so line numbers don't move. |
| Runtime | `background/userscript-runtime.js` | A self-contained function serialized into each script's world before its code. It reports runs and errors and defines only the GM APIs the script grants. |
| Dependencies and updates | `background/dependencies.js`, `background/updates.js` | Download `@require` and `@resource` files (reusing ones already fetched for the same URL), check update URLs, and decide whether an update can apply without review. |
| Install page | `install/` | Opened for `.user.js` links. Downloads and validates the script, shows what it can do and how it differs from an installed copy, requests site access and asks the worker to install it. |
| Manager | `manager/` | The full-page editor and library. `manager.js` holds page state, the library list and the editor pane. `dialogs.js` (history, values, Trash, site access, settings, import and export) and `updates-ui.js` get a small `app` object from it instead of sharing globals; `ui.js` has their DOM helpers. `code-editor.js` sets up CodeMirror and adapts `intellisense.js` (completions, problems and quick fixes, hover docs, all computed from plain text so they're testable in Node) with the API reference in `gm-api.js`. `editor-state.js` keeps the parsed header and finds the call under the cursor incrementally, so long scripts stay fast to type in. `editor.js` (static highlighting for the install page), `diff.js`, `backup-file.js` and `templates.js` are side-effect-free helpers. |
| Popup | `popup/` | Shows scripts matching the active tab, their last run or error, menu commands, Run now and quick toggles. |
| Shared | `shared/` | Metadata parsing, match, glob and regex rules, grant families and version comparison (`userscript.js`), install helpers (`install.js`), syntax validation (`validate.js`), the storage layout and its upgrades (`storage.js`), message definitions (`messages.js`), data shapes for the type checker (`types.js`), Chrome sync backup and time formatting. |

## Data

| Key | Area | Contents |
| --- | --- | --- |
| `schemaVersion` | local | Version of this layout, currently 2. `storage.js` upgrades older data step by step when the service worker starts. |
| `scriptOrder` | local | Script IDs in run order. |
| `script:<id>` | local | One script: `{ id, name, source, enabled, history[], updatedAt }`, plus `installUrl`, `installedHash`, `autoUpdate`, `updateCheck` and `pendingUpdate` for installed scripts. A save writes only the scripts that changed. |
| `bridgeSecret` | local | Random key used to sign each script's messages. It never leaves the extension. |
| `deps:<id>` | local | Downloaded `@require` code and `@resource` data URLs, or the error from the last download. |
| `trash` | local | Deleted scripts with `deletedAt`, purged after 30 days. |
| `settings` | local | `paused`, `reloadAfterSave`, `syncBackup`, `lastExportAt`. |
| `values:<id>` | local | Values a script stored with `GM.setValue`. |
| `syncState` | local | Result of the last Chrome sync backup. |
| `registrationState` | session | Which scripts Chrome registered and why others were not. |
| `runs`, `tabRuns` | session | Last run and error per script, and per tab the runs and menu commands for the popup and badge. |
| `notifications`, `openedTabs` | session | Which script and page own each notification and each tab a script opened. |
| `backup:<n>`, `syncBackup` | sync | Chunked copy of script sources when sync backup is on. |

## Storage upgrades

`shared/storage.js` holds `schemaVersion` and a `migrations` table with one function per version. To change the layout, raise `schemaVersion`, add the step that converts the previous layout, and add a test in `tests/storage-and-messages.test.mjs`. Steps must be safe to run twice, because the worker can stop partway through. Pages can open before an upgrade finishes, so `readScripts` still reads the version 1 layout.

## Messages

Extension pages send `{ type, ... }` messages to the service worker, which only accepts them from its own manager, popup and install page: `sync`, `save`, `toggle`, `delete`, `restore`, `purge`, `import`, `move`, `label`, `settings`, `clear-values`, `install`, `apply-update`, `dismiss-update`, `auto-update` and `exclude-site` go through the write queue. Saves and deletes carry the record the page loaded, so an edit made elsewhere in the meantime is rejected instead of overwritten. Downloads for `save`, `install`, `import` and `apply-update` happen before the message joins the queue. `check-updates`, `run-now` and `menu-run` answer directly.

Userscripts send `run`, `error`, `menu`, `value`, `xhr`, `notify`, `open-tab` and `close-tab` messages through `chrome.runtime.onUserScriptMessage`. Chrome doesn't say which script's world sent a message, so each script's runtime signs its messages with a token: an HMAC of the script ID under `bridgeSecret`. A script only ever holds its own token, because worlds are isolated from each other and from the page, and page-world scripts get none. The worker verifies the token, then checks the script's grants, and for requests its `@connect` hosts, before acting. To call back into a page (a menu command or a notification click) the worker runs one line in the script's world with `chrome.userScripts.execute`, targeting the document that registered it.
