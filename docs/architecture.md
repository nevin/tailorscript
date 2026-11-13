# Architecture

Tailorscript is plain JavaScript modules with no bundler. `src/` is the extension exactly as Chrome loads it; the build only copies it and stamps the version.

## Pieces

| Part | Files | Responsibility |
| --- | --- | --- |
| Service worker | `background/service-worker.js` | Owns every write to `chrome.storage.local` through one queue, so saves, toggles, imports and Trash operations never interleave. Handles messages from the manager and popup, run and error reports, and `GM.*Value` requests from userscripts. |
| Registration | `background/registration.js` | Turns stored scripts into `chrome.userScripts` registrations in library order. Each script runs in its own world after a generated prelude that reports runs and errors and defines only the APIs the script grants. |
| Manager | `manager/` | The full-page editor and library. `manager.js` holds page state and wiring; `editor.js`, `diff.js`, `backup-file.js` and `templates.js` are side-effect-free helpers. |
| Popup | `popup/` | Shows scripts matching the active tab, their last run or error, and quick toggles. |
| Shared | `shared/` | Metadata parsing and match rules (`userscript.js`), syntax validation (`validate.js`), storage reads, Chrome sync backup and time formatting. |

## Data

| Key | Area | Contents |
| --- | --- | --- |
| `scripts` | local | Ordered library: `{ id, name, source, enabled, history[], updatedAt }`. Order is run order. |
| `trash` | local | Deleted scripts with `deletedAt`, purged after 30 days. |
| `settings` | local | `paused`, `reloadAfterSave`, `syncBackup`, `lastExportAt`. |
| `values:<id>` | local | Values a script stored with `GM.setValue`. |
| `syncState` | local | Result of the last Chrome sync backup. |
| `registrationState` | session | Which scripts Chrome registered and why others were not. |
| `runs`, `tabRuns` | session | Last run and error per script, and per tab for the popup. |
| `backup:<n>`, `syncBackup` | sync | Chunked copy of script sources when sync backup is on. |

## Messages

Extension pages send `{ type, ... }` messages to the service worker, which only accepts them from its own manager and popup URLs: `sync`, `save`, `toggle`, `delete`, `restore`, `purge`, `import`, `move`, `label`, `settings` and `clear-values`. Saves and deletes carry the record the page loaded, so an edit made elsewhere in the meantime is rejected instead of overwritten.

Userscripts send `run`, `error` and `value` messages through `chrome.runtime.onUserScriptMessage`. The worker identifies the script by its world ID and checks its grants before touching stored values.
