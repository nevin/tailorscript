# Tailorscript

Tailor websites with your own JavaScript. Tailorscript is a Chrome 138+ userscript manager that runs your scripts on the HTTP and HTTPS pages you choose. Scripts stay in your Chrome profile and are never sent anywhere.

## Install for development

Requires Node.js 22.2 or later (`.nvmrc` pins the CI version).

```bash
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `dist/` directory. You can also load `src/` directly while editing, since it needs no compilation.
3. Open **Details** for Tailorscript and turn on **Allow User Scripts**.
4. Click the Tailorscript toolbar button and choose **Open manager**.
5. Check **Enabled** on the starter script, click **Save script**, and grant site access.
6. Open or reload `https://example.com/`. Its heading should turn purple, and the toolbar popup shows when the script ran.

## Project layout

```
src/                 The extension, loadable as-is
  manifest.json
  background/        Service worker and userscript registration
  manager/           Full-page script manager and its editor, diff, import and template modules
  popup/             Toolbar popup
  shared/            Metadata parsing, validation, storage and sync backup used by every page
  icons/             Logo sources (SVG) and the PNG sizes Chrome needs
  vendor/acorn/      Vendored JavaScript parser (MIT)
scripts/             Build, check, package and Web Store submission tools (Node built-ins only)
tests/               node:test suites with an in-memory Chrome API mock
docs/                Architecture, publishing guide, store listing and privacy policy
```

See [docs/architecture.md](docs/architecture.md) for how the pieces talk to each other.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Copies `src/` into a clean `dist/`, stamps the `package.json` version and validates the result. |
| `npm run check` | Validates `src/`: manifest rules, icon sizes, version match, missing files and remote code. |
| `npm run lint` | Runs ESLint. |
| `npm test` | Runs the unit and integration tests. |
| `npm run verify` | Lint, tests and check together, as CI runs them. |
| `npm run package` | Builds and writes a reproducible `release/tailorscript-<version>.zip` with a SHA-256 checksum. |
| `npm run release` | `verify`, then `package`. |
| `npm run submit` | Uploads the package to the Chrome Web Store. See [docs/publishing.md](docs/publishing.md). |
| `npm version <patch\|minor\|major>` | Bumps the version in `package.json` and `src/manifest.json` together. |

## The toolbar popup

The popup lists the scripts that match the current tab. Each shows whether it ran on this page, or the error it threw, with a switch to turn it on or off and an **Edit** link into the manager. Use **Reload tab** after a change, **Check this page** to open diagnostics, and **Pause all** to stop every script on new page loads without changing their settings.

## Write a script

Use **New script** to start from a template (blank, CSS, hiding elements, auto-clicking, keyboard shortcuts, waiting for an element, or stored settings), then set its name and sites. Scripts use a `// ==UserScript==` metadata block. Supported directives:

| Directive | Meaning |
| --- | --- |
| `@name` | Name shown in the library. |
| `@match`, `@exclude-match` | Chrome match patterns for HTTP(S) pages. |
| `@run-at` | `document-start`, `document-end`, or `document-idle` (default). |
| `@grant` | `none`, `GM_addStyle`, `GM.getValue`, `GM.setValue`, `GM.deleteValue`, `GM.listValues`. |
| `@all-frames` | Also run in matching iframes. Scripts run in the top frame only by default; `@noframes` states that explicitly. |
| `@tag` | Library tags for filtering, separated by spaces or commas. |

Scripts run in separate userscript worlds. `GM_addStyle(css)` adds a stylesheet. The `GM.*Value` functions return promises and store JSON-compatible values per script (up to 1 MB) in this Chrome profile; view or clear them under **Stored values**. Other Tampermonkey APIs, `@require`, and automatic updates are unsupported.

The editor highlights JavaScript, matching brackets, and syntax errors. Shortcuts: ⌘/Ctrl+S save, ⌘/Ctrl+F find and replace, ⌘/Ctrl+] and ⌘/Ctrl+[ indent and outdent lines, ⌘/Ctrl+/ toggle comments.

Changes take effect on the next matching page load. Turn on **Reload matching tabs after saving** to reload them for you.

## Library

Switch scripts on and off from the library, filter by state, tag, or the page under **Check a page**, and sort by run order, name, or last edit. When several scripts share a page and timing, they run in library order; change it with **Run earlier** and **Run later**.

**Move to Trash** keeps a script for 30 days, with an **Undo** link right after deleting. Restored scripts come back disabled.

## Registration, errors, and site access

The library shows whether Chrome registered each enabled script, when it last ran, and whether it threw an uncaught error, with a **Go to line** link. Run reports cover the most recent page load and reset when Chrome restarts.

Chrome storage holds the saved source and enabled setting, while the service worker reconciles Chrome's registrations on startup, extension updates, permission changes, and when you open the manager. If registration fails, your source stays saved. Reopen the manager to retry, or save the enabled script to request missing site access. **Site access** lists granted sites, which scripts use them, and lets you remove access.

When two manager tabs edit the same script, or the popup changes it while you have unsaved edits, the save is rejected if the stored script changed in the meantime. Copy any unsaved changes before reloading.

## Back up and restore

- **Export backup** downloads a JSON file with script sources and history. The library reminds you when changes haven't been exported for a week.
- **Backup settings** can copy script sources to Chrome sync after every change (about 100 KB total, sources only) and restore them on another profile.
- **Import scripts** accepts a backup or a `.user.js` file. The review lets you skip scripts, add copies, or replace a script with the same name. Imported and replaced scripts are disabled until you review them. Site grants, enabled settings, and stored values are not included.
- **Version history** keeps 25 previous versions per script. Label a version, compare it line by line with the editor, or load it and save to restore it.
