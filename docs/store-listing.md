# Chrome Web Store listing

Copy these into the Developer Dashboard. Keep them in sync with what the extension does.

## Summary (132 characters max)

Tailor websites with your own JavaScript. A private userscript manager that keeps scripts in your browser.

## Description

Tailorscript lets you change how websites look and behave by running your own JavaScript on the pages you choose.

- Write scripts in a built-in editor with syntax highlighting, error checking, find and replace, and version history with side-by-side comparison.
- Start from templates: add CSS, hide clutter, click buttons automatically, add keyboard shortcuts, wait for elements, or remember settings.
- See at a glance from the toolbar which scripts ran on the current page and which hit errors, with a jump to the failing line.
- Control where scripts run with match rules, decide their order, pause everything with one switch, and restore deleted scripts from the Trash for 30 days.
- Back up to a file or to Chrome sync, and import scripts with a review step. Imported scripts start disabled.

Tailorscript runs only code you write or import yourself. It does not download scripts, update them from the web, or send your data anywhere.

## Category

Developer Tools

## Single purpose

Run the user's own JavaScript userscripts on websites the user chooses.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `userScripts` | Registers the scripts the user writes or imports so Chrome runs them on matching pages. This is the extension's core function. |
| `storage` | Saves the user's scripts, settings, version history and values scripts store, all locally in the browser. Optionally copies script sources to the user's own Chrome sync storage as a backup. |
| `activeTab` | Lets the toolbar popup read the current tab's address to list the scripts that match it. |
| Optional host permissions (`http://*/*`, `https://*/*`) | Requested one site at a time, only when the user enables a script for that site, so Chrome can run it there. Users can remove access from the extension's Site access panel. |

## Remote code

No. Userscripts are written or imported by the user and stored locally. The extension's own code is entirely in the package, and it never fetches or evaluates code from the network.

## Data usage

The extension does not collect or transmit user data. Disclose no data types. Certify that data is not sold, not used for unrelated purposes and not used for creditworthiness.
