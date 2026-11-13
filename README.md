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
5. Check **Enabled** on the starter script, click **Save**, and grant site access.
6. Open or reload `https://example.com/`. Its heading should turn purple, and the toolbar popup shows when the script ran.

## Project layout

```
src/                 The extension, loadable as-is
  manifest.json
  background/        Service worker and userscript registration
  manager/           Full-page script manager and its editor, diff, import and template modules
  popup/             Toolbar popup
  install/           Install page for .user.js links
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

The toolbar badge counts the scripts that ran on the current tab and turns red when one of them threw an error. The popup lists the scripts that match the tab, whether each ran or the error it threw, and a switch to turn it on or off. The **⋯** button on a script offers:

- **Run now**: run it once on this page, even if it's turned off. Scripts with `@run-at context-menu` only ever run this way.
- **Edit**: open it in the manager.
- **Don't run on this site**: add an `@exclude-match` line for the current site.

Commands that scripts add with `GM_registerMenuCommand` appear under the script. **Find scripts for this site** searches Greasy Fork. If the tab shows a `.user.js` file, the popup offers to install it. **Pause all** (or the keyboard shortcut, Alt+Shift+P by default) stops every script on new page loads; the badge shows "off" while paused.

If Chrome's **Allow User Scripts** switch is off, the popup and manager say so and link to the extension's details page.

## Install and update scripts

Open a `.user.js` link, or use **Install from URL…** in the manager's menu. Tailorscript shows an install page with the script's sites, the APIs it can use, any code it loads, and the code itself. For a script you already have, it shows the changes. Turn on **One-click installs** under **Settings & backup** to open `.user.js` links on Greasy Fork, OpenUserJS and GitHub directly in the install page.

Installed scripts check `@updateURL` (or `@downloadURL`, or the address they came from) every 12 hours. An update installs on its own only when it needs no new site access, APIs or libraries, and you haven't edited the script since installing it. Otherwise the script shows **Update available**, and you review the changes before applying or skipping them. **Updates…** in the script menu shows where a script came from, lets you check now, and turns automatic updates off. **Check for updates** checks every installed script.

## Write a script

Use **New script** to start from a template (blank, CSS, hiding elements, auto-clicking, keyboard shortcuts, waiting for an element, stored settings, a menu command, or fetching from another site), then set its name and sites. Scripts use a `// ==UserScript==` metadata block. Supported directives:

| Directive | Meaning |
| --- | --- |
| `@name`, `@namespace`, `@version`, `@description`, `@author` | Shown in the library and install page. `@version` decides whether an update is newer. |
| `@match`, `@exclude-match` | Chrome match patterns for HTTP(S) pages. `<all_urls>` means every HTTP(S) page. |
| `@include`, `@exclude` | Globs (`*` matches anything, `.tld` any top-level domain) or `/regular expressions/`. Regular expressions register the script on every site and check the address before the code runs. |
| `@run-at` | `document-start`, `document-end` (`document-body` is treated the same), `document-idle` (default), or `context-menu` to run only from **Run now**. |
| `@grant` | The APIs below. Grants Tailorscript doesn't provide are listed as a warning instead of blocking the script. |
| `@require` | Library URLs loaded before the script, downloaded when you save or install. |
| `@resource` | `name url` files for `GM_getResourceText` and `GM_getResourceURL`. |
| `@connect` | Hosts `GM_xmlhttpRequest` may reach, besides the page's own site. `*` allows any host. |
| `@updateURL`, `@downloadURL` | Where to check for and download updates. |
| `@inject-into page` (or `@sandbox raw`) | Run in the page's own JavaScript context, sharing its variables. Such scripts can use only `GM_addStyle`, `GM_info` and `unsafeWindow`, and their runs aren't reported. |
| `@all-frames` | Also run in matching iframes. Scripts run in the top frame only by default; `@noframes` states that explicitly. |
| `@tag` | Library tags for filtering, separated by spaces or commas. |

APIs, each available in the classic `GM_` form and the promise-based `GM.` form:

| API | Grant |
| --- | --- |
| `GM_info` / `GM.info` | Always available. |
| `GM_addStyle` | `GM_addStyle` or `GM.addStyle` |
| `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues` and the `GM.` versions | Values are JSON-compatible, per script, up to 1 MB, kept in this Chrome profile. The synchronous `GM_` versions read a copy taken when the page loaded. View or clear values under **Stored values**. |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | Cross-site requests through the extension, limited to `@connect` hosts. Supports `responseType` text, json, arraybuffer, blob and document, timeouts and `abort()`. |
| `GM_registerMenuCommand`, `GM_unregisterMenuCommand` | Commands shown in the popup. |
| `GM_notification` | Desktop notifications with `onclick` and `ondone`. |
| `GM_setClipboard` | Copies text or HTML. |
| `GM_openInTab` | Opens http(s) pages in new tabs; scripts can close only tabs they opened. |
| `GM_getResourceText`, `GM_getResourceURL` / `GM.getResourceUrl` | Read `@resource` files. |
| `unsafeWindow` | The window object. Scripts run in an isolated world, so use `@inject-into page` to reach the page's own variables. |

The editor highlights JavaScript, matching brackets, and syntax errors. It suggests metadata keys, `@grant` values and GM APIs as you type (Ctrl+Space to ask), and offers to add missing `@grant` lines when the code calls an API it hasn't granted. Shortcuts: ⌘/Ctrl+S save, ⌘/Ctrl+F find and replace, ⌘/Ctrl+] and ⌘/Ctrl+[ indent and outdent lines, ⌘/Ctrl+/ toggle comments.

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
