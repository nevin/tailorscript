# Changelog

All notable changes to Tailorscript are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0]

### Added
- Visual script builder: a **Tailorscript** tab in the page's developer tools that builds a script without code. It lists the page's elements by kind, outlines them as you point at them, and **Pick on page** adds one by clicking it.
- Drag an element onto an action or into the step list, and drag steps to reorder them. **Add**, the action buttons and the arrow buttons do the same from the keyboard.
- Actions: hide, click automatically, fill in a field, replace text, text and background colour, font size, outline, add a note, click with a keyboard shortcut, and a button in the Tailorscript popup. Repeated elements, such as each product's button, can be changed one at a time or all together.
- **Test** runs the steps on the page and undoes them afterwards, with a result on each step. **View code** shows the generated script and a plain summary. Recipes can be saved, reopened, turned on and opened in the manager from the panel, and unsaved work is kept per site.
- A welcome panel for new users with ways to start: a template, the visual builder, a shared link or a backup. The template picker and the popup's **More** menu explain how to open the visual builder.
- The manager shows the installed version.

### Changed
- Library rows show where each script runs and mention its status only when there is something to say. **Checked page** appears once a page has been checked.
- The popup no longer marks every script with a warning before a reload; the Reload button says **Reload to apply** instead. Less-used links moved into **More**.
- All pages share one set of colour tokens.
- Registration skips scripts that haven't changed, and Run now reports errors from the page.

### Fixed
- Template cards in the new-script picker line up their text.
- Narrow manager windows keep the Save and Find hints, and the popup keeps its width on restricted pages.

## [0.6.0]

### Added
- Project page with install steps and the privacy policy, published to GitHub Pages from `site/`.
- MIT licence.
- Scripting guide inside the extension, for people new to userscripts: what a script and its header are, what GM APIs are and how `@grant` works, a task-by-task reference with a complete example for every API, common mistakes and every header key. **Start a script from this** opens an example in the editor. Reach it from **Guide** in the manager, the popup, the template picker, or the link in the editor's hover docs.

### Changed
- Turning a script on in the popup now asks for site access there, instead of opening the manager.

## [0.5.0]

### Added
- Install page for `.user.js` links and **Install from URL…**, showing sites, APIs, loaded code, the source and changes from an installed copy. Optional one-click installs from Greasy Fork, OpenUserJS and GitHub.
- Automatic updates from `@updateURL`/`@downloadURL` every 12 hours. Updates that need new access, APIs or libraries, or would replace local edits, wait for review with a diff.
- `@require` and `@resource`, downloaded on save or install and cached per script.
- `@include` and `@exclude` globs and regular expressions, `<all_urls>`, `@connect`, `@inject-into page`, and `@run-at context-menu`.
- GM APIs: `GM_xmlhttpRequest`, menu commands, notifications, clipboard, `GM_openInTab`, resources, `GM_info`, `unsafeWindow`, and synchronous `GM_*Value` functions.
- Popup: toolbar badge with run count and errors, Run now, Don't run on this site, script menu commands, Find scripts for this site, and installing the open `.user.js` file.
- Setup check that explains how to turn on Allow User Scripts when Chrome blocks userscripts.
- Keyboard shortcut to pause or resume all scripts.
- CodeMirror-based editor with completions for metadata, GM APIs, local variables, browser APIs and userscript snippets; inline problems with quick fixes (missing `@grant` or `@connect`, unused or unsupported grants, unknown metadata, the last run's error); hover docs; parameter hints; folding, multiple cursors and regex find and replace.
- `npm run vendor` to rebuild the vendored CodeMirror bundle.
- **Copy diagnostics** in Settings & backup: versions, settings, registration issues and recent errors for bug reports, never script code.
- End-to-end tests that load the extension in a real Chrome (`npm run test:e2e`), type checking with JSDoc and `@types/chrome` (`npm run typecheck`), a coverage threshold, `npm run dev` with rebuild and reload, `npm run harness` for UI work in a plain browser tab, a CI check that the vendored bundle matches a fresh build, and Dependabot.

- Build, check, package and Chrome Web Store submission scripts, CI and release workflows.
- ESLint configuration and a `node:test` suite covering parsing, registration, the service worker, sync backup, packaging and submission.

- "New script for this site" in the popup opens the template picker with the current site filled in.

### Security
- The install page refuses to run inside a frame, so other sites can't disguise its Install button, and new installs start turned off unless you choose otherwise.
- Updates downloaded over plain http, or that load http code, always wait for review. The install page and editor flag http downloads, and the editor offers a "Use https" fix.
- `GM_xmlhttpRequest` checks `@connect` against the final address after redirects.
- Installing a script from a different address that reuses an installed script's name and namespace now shows a warning, because it would inherit that script's stored data.
- Each script signs its messages with a private token, so one script can't use another's stored values or `@connect` hosts. `@resource` data URLs keep only a plain media type.
- The service worker checks every message's fields against one schema before acting on it.
- CI and release workflows run with read-only repository access and actions pinned to exact commits.

### Fixed
- GM APIs that talk to the extension (stored values, `GM_xmlhttpRequest`, notifications, `GM_openInTab`, menu commands) and run reports now work in Chrome. Each script's world is set up for messaging, which Chrome requires per world.

### Changed
- Each script is stored under its own key with a storage version number, so saving one script no longer rewrites the others. Existing libraries upgrade automatically.
- The editor re-reads the metadata header only when it changes and finds parameter hints from its syntax tree, so long scripts stay responsive.
- The service worker and manager are split into smaller modules.
- Unsupported `@grant` values are now a warning instead of an error.
- Source reorganised under `src/` into background, manager, popup and shared modules.
- Manager redesign: full-height layout, on/off switches, status dots and pills, filter chips, match rules shown as chips, a clear error callout with Go to line, and overflow menus for library and script actions.
- "Reload matching tabs after saving" moved into a Settings & backup dialog.
- Popup redesign: site header with script count, switches, plainer status text and an empty state.

## [0.4.0]

### Added
- Renamed to Tailorscript, with a new sewing-machine logo.
- Toolbar popup listing scripts for the current tab with run status, errors and quick toggles.
- Run and error reporting with Go to line, Pause all, reload matching tabs after saving.
- `GM.getValue`, `GM.setValue`, `GM.deleteValue` and `GM.listValues`, plus a stored values viewer.
- `@all-frames`, `@noframes` and `@tag` metadata; library filters, sorting and run order.
- Trash with 30-day recovery and Undo, labelled version history with diffs, import review with duplicate handling.
- Find and replace, line indent, outdent and comment toggling, bracket matching, and script templates.
- Site access panel, Chrome sync backup and export reminders.
