# Architecture

Tailorscript is plain JavaScript modules with no bundler. `src/` is the extension exactly as Chrome loads it; the build only copies it and stamps the version. Third-party code is vendored under `src/vendor/`: acorn as published, and CodeMirror as one ES module bundle that `npm run vendor` builds with esbuild from `scripts/vendor/codemirror-entry.mjs`.

## Pieces

| Part | Files | Responsibility |
| --- | --- | --- |
| Service worker | `background/service-worker.js` | Owns every write to `chrome.storage.local` through one queue, so saves, toggles, imports and Trash operations never interleave. Handles messages from the manager, popup and install page, run, error and menu reports, and GM API requests from userscripts. Sets the toolbar badge, schedules update checks and registers the `.user.js` redirect. |
| Registration | `background/registration.js` | Turns stored scripts into `chrome.userScripts` registrations in library order: match patterns, include globs, `@require` files and the script. A regular-expression `@include` wraps the script in an address check on its first line, so line numbers don't move. |
| Runtime | `background/userscript-runtime.js` | A self-contained function serialized into each script's world before its code. It reports runs and errors and defines only the GM APIs the script grants. |
| Dependencies and updates | `background/dependencies.js`, `background/updates.js` | Download `@require` and `@resource` files (reusing ones already fetched for the same URL), check update URLs, and decide whether an update can apply without review. |
| Install page | `install/` | Opened for `.user.js` links. Downloads and validates the script, shows what it can do and how it differs from an installed copy, requests site access and asks the worker to install it. |
| Manager | `manager/` | The full-page editor and library. `manager.js` holds page state and wiring. `code-editor.js` sets up CodeMirror and adapts `intellisense.js` (completions, problems and quick fixes, hover docs and parameter hints, all computed from plain text so they're testable in Node) with the API reference in `gm-api.js`. `editor.js` (static highlighting for the install page), `diff.js`, `backup-file.js` and `templates.js` are side-effect-free helpers. |
| Popup | `popup/` | Shows scripts matching the active tab, their last run or error, menu commands, Run now and quick toggles. |
| Shared | `shared/` | Metadata parsing, match, glob and regex rules, grant families and version comparison (`userscript.js`), install helpers (`install.js`), syntax validation (`validate.js`), storage reads, Chrome sync backup and time formatting. |

## Data

| Key | Area | Contents |
| --- | --- | --- |
| `scripts` | local | Ordered library: `{ id, name, source, enabled, history[], updatedAt }`, plus `installUrl`, `installedHash`, `autoUpdate`, `updateCheck` and `pendingUpdate` for installed scripts. Order is run order. |
| `deps:<id>` | local | Downloaded `@require` code and `@resource` data URLs, or the error from the last download. |
| `trash` | local | Deleted scripts with `deletedAt`, purged after 30 days. |
| `settings` | local | `paused`, `reloadAfterSave`, `syncBackup`, `lastExportAt`. |
| `values:<id>` | local | Values a script stored with `GM.setValue`. |
| `syncState` | local | Result of the last Chrome sync backup. |
| `registrationState` | session | Which scripts Chrome registered and why others were not. |
| `runs`, `tabRuns` | session | Last run and error per script, and per tab the runs and menu commands for the popup and badge. |
| `notifications`, `openedTabs` | session | Which script and page own each notification and each tab a script opened. |
| `backup:<n>`, `syncBackup` | sync | Chunked copy of script sources when sync backup is on. |

## Messages

Extension pages send `{ type, ... }` messages to the service worker, which only accepts them from its own manager, popup and install page: `sync`, `save`, `toggle`, `delete`, `restore`, `purge`, `import`, `move`, `label`, `settings`, `clear-values`, `install`, `apply-update`, `dismiss-update`, `auto-update` and `exclude-site` go through the write queue. Saves and deletes carry the record the page loaded, so an edit made elsewhere in the meantime is rejected instead of overwritten. Downloads for `save`, `install`, `import` and `apply-update` happen before the message joins the queue. `check-updates`, `run-now` and `menu-run` answer directly.

Userscripts send `run`, `error`, `menu`, `value`, `xhr`, `notify`, `open-tab` and `close-tab` messages through `chrome.runtime.onUserScriptMessage`. The worker identifies the script by its world ID and checks its grants, and for requests its `@connect` hosts, before acting. To call back into a page (a menu command or a notification click) the worker runs one line in the script's world with `chrome.userScripts.execute`, targeting the document that registered it.
