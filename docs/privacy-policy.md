# Tailorscript privacy policy

Tailorscript runs JavaScript that you write or import on websites you choose.

**What it stores.** Your scripts, their version history, your settings, and any values your scripts save are kept in your browser's extension storage on your device. If you turn on Chrome sync backup, the source code of your scripts is also saved to your Chrome sync storage, which Google syncs between your own signed-in browsers.

**What it sends.** Tailorscript has no servers, analytics, advertising or tracking, and does not share or sell any data. It does not read page content except as your own scripts do when they run. It connects to other websites only:

- to download a script you choose to install, and the `@require` and `@resource` files a script lists;
- to check the address a script you installed came from (or its `@updateURL`) for updates, unless you turn automatic updates off;
- when a script you run calls `GM_xmlhttpRequest`, to the page's own site or the sites that script lists with `@connect`.

These requests go directly from your browser to those sites. Downloads and update checks don't include cookies. Requests a script makes with `GM_xmlhttpRequest` include your cookies for the site it contacts, unless the script asks for an anonymous request.

**Site access.** Tailorscript asks for access to a site only when you enable a script for it, or turn on one-click installs for Greasy Fork, OpenUserJS and GitHub. You can remove access at any time from the extension's Site access panel or Chrome's extension settings.

**Your control.** Deleting a script moves it to the Trash, which is emptied after 30 days or when you choose. Removing the extension deletes all of its local data.

Questions: contact the developer through the Chrome Web Store listing.
