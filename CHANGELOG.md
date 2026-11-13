# Changelog

All notable changes to Tailorscript are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Build, check, package and Chrome Web Store submission scripts, CI and release workflows.
- ESLint configuration and a `node:test` suite covering parsing, registration, the service worker, sync backup, packaging and submission.

### Changed
- Source reorganised under `src/` into background, manager, popup and shared modules.

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
