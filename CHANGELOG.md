# Changelog

All notable changes to Tailorscript are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Install page for `.user.js` links and **Install from URL…**, showing sites, APIs, loaded code, the source and changes from an installed copy. Optional one-click installs from Greasy Fork, OpenUserJS and GitHub.
- Automatic updates from `@updateURL`/`@downloadURL` every 12 hours. Updates that need new access, APIs or libraries, or would replace local edits, wait for review with a diff.
- `@require` and `@resource`, downloaded on save or install and cached per script.
- `@include` and `@exclude` globs and regular expressions, `<all_urls>`, `@connect`, `@inject-into page`, and `@run-at context-menu`.
- GM APIs: `GM_xmlhttpRequest`, menu commands, notifications, clipboard, `GM_openInTab`, resources, `GM_info`, `unsafeWindow`, and synchronous `GM_*Value` functions.
- Popup: toolbar badge with run count and errors, Run now, Don't run on this site, script menu commands, Find scripts for this site, and installing the open `.user.js` file.
- Setup check that explains how to turn on Allow User Scripts when Chrome blocks userscripts.
- Keyboard shortcut to pause or resume all scripts.
- Editor autocomplete for metadata, grants and GM APIs, and a one-click fix for missing `@grant` lines.

- Build, check, package and Chrome Web Store submission scripts, CI and release workflows.
- ESLint configuration and a `node:test` suite covering parsing, registration, the service worker, sync backup, packaging and submission.

- "New script for this site" in the popup opens the template picker with the current site filled in.

### Changed
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
