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
- Install scripts from Greasy Fork, OpenUserJS, GitHub or any .user.js link after reviewing what they do, and keep them updated. Updates that need new access wait for your review.
- Use @require libraries and the familiar GM APIs: requests to other sites, menu commands, notifications, clipboard, stored values and more.
- Run a script once from the toolbar, stop it on one site, or pause everything with a keyboard shortcut.
- Back up to a file or to Chrome sync, and import scripts with a review step. Imported scripts start disabled.

Tailorscript runs only scripts you write or choose to install. It has no servers and sends your data nowhere.

## Category

Developer Tools

## Single purpose

Manage and run userscripts that the user writes or chooses to install, on websites the user chooses.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `userScripts` | Registers the scripts the user writes or imports so Chrome runs them on matching pages. This is the extension's core function. |
| `storage` | Saves the user's scripts, settings, version history and values scripts store, all locally in the browser. Optionally copies script sources to the user's own Chrome sync storage as a backup. |
| `unlimitedStorage` | Keeps scripts' downloaded `@require` libraries and resources locally, which can exceed the default storage quota. |
| `activeTab` | Lets the toolbar popup read the current tab's address to list matching scripts, and run a script once on that tab when the user clicks Run now. |
| `alarms` | Schedules the update check for scripts the user installed. |
| `notifications` | Shows notifications that the user's scripts request with GM_notification. |
| `declarativeNetRequestWithHostAccess` | Opens .user.js links on sites the user granted in Tailorscript's install page, so they can review a script before installing it. |
| Optional host permissions (`http://*/*`, `https://*/*`) | Requested only for the sites a script runs on or lists with @connect, when the user enables it, or for Greasy Fork, OpenUserJS and GitHub when the user turns on one-click installs. Users can remove access from the extension's Site access panel. |

## Remote code

Yes, only through the userScripts API. Tailorscript is a userscript manager: it runs scripts the user writes, or installs after reviewing them on its install page, along with the libraries those scripts declare with @require. The extension's own code is entirely in the package.

## Data usage

The extension does not collect or transmit user data. Disclose no data types. Certify that data is not sold, not used for unrelated purposes and not used for creditworthiness.
