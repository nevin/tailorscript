// The manager's dialogs: version history, stored values, Trash, site access, settings and backup, import and export,
// install from URL and diagnostics.
import { $ } from "../shared/dom.js";
import { timeAgo } from "../shared/format.js";
import { formatDiagnostics } from "../shared/diagnostics.js";
import { installOrigins, installPageUrl } from "../shared/install.js";
import { readScripts, readValues } from "../shared/storage.js";
import { readSyncBackup } from "../shared/sync-backup.js";
import { decodeImport } from "./backup-file.js";
import { diffView } from "./diff.js";
import { element, makeButton, openReview, review, switchControl } from "./ui.js";

export function setupDialogs(app) {
  const importFile = $("#import-file", HTMLInputElement);

  function downloadBackup(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tailorscript-backup.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reviewImport(entries, origin) {
    const rows = element("ul", undefined, "import-list");
    const choices = entries.map(entry => {
      const identical = app.scripts.find(script => script.source === entry.source);
      const sameName = app.scripts.find(script => script.name === entry.name);
      const item = element("li");
      const choice = document.createElement("select");
      choice.append(new Option("Add as a new script", "new"));
      if (!identical && sameName) choice.append(new Option(`Replace “${sameName.name}” (disables it for review)`, sameName.id));
      choice.append(new Option("Skip", "skip"));
      choice.value = identical ? "skip" : "new";
      choice.setAttribute("aria-label", `Import action for ${entry.name}`);
      item.append(element("strong", entry.name),
        element("span", ` — ${[...entry.matches, ...entry.includes].join(", ")}${entry.excludeMatches.length + entry.excludes.length
          ? `; excludes ${[...entry.excludeMatches, ...entry.excludes].join(", ")}` : ""}`),
        element("span", identical ? "Identical to a script in your library." : sameName ? "A script with this name already exists." : "", "import-note"),
        choice);
      rows.append(item);
      return choice;
    });
    openReview(`Review import from ${origin}`, element("p", "Imported scripts start disabled so you can review them."), rows,
      makeButton("Import selected", () => {
        const chosen = entries.flatMap(({ source, history }, index) => {
          const action = choices[index].value;
          return action === "skip" ? [] : [{ source, history, ...(action === "new" ? {} : { replace: action }) }];
        });
        review.close();
        if (!chosen.length) return;
        app.perform(async () => {
          await app.send({ type: "import", entries: chosen });
          await app.reloadData();
          const replacedSelected = chosen.some(entry => entry.replace === app.selectedId);
          if (replacedSelected && !app.isDirty()) app.select(app.scripts.find(item => item.id === app.selectedId));
          app.status.textContent = `Imported ${chosen.length} disabled script(s).` +
            (replacedSelected && app.isDirty() ? " The open script was replaced; reload it before saving." : "");
        });
      }));
  }

  function showHistory() {
    const script = app.scripts.find(item => item.id === app.selectedId);
    if (!script?.history?.length) return;
    const versions = document.createElement("ol");
    for (const version of script.history) {
      const item = document.createElement("li");
      const details = document.createElement("details");
      const summary = element("summary", new Date(version.savedAt).toLocaleString());
      if (version.label) summary.append(" — ", element("strong", version.label));
      const label = document.createElement("input");
      label.type = "text";
      label.value = version.label ?? "";
      label.placeholder = "Label this version";
      label.maxLength = 80;
      label.setAttribute("aria-label", "Version label");
      const preview = element("pre", version.source, "version-source");
      const actions = element("div", undefined, "version-actions");
      actions.append(label, makeButton("Save label", () => {
        review.close();
        app.perform(async () => {
          await app.send({ type: "label", id: script.id, savedAt: version.savedAt, label: label.value });
          await app.reloadData();
          app.loaded = { ...app.loaded, history: app.scripts.find(item => item.id === script.id)?.history };
          showHistory();
        });
      }), makeButton("Compare with editor", () => {
        try {
          openReview(`Changes since ${new Date(version.savedAt).toLocaleString()}`,
            element("p", "Lines marked - are only in that version. Lines marked + are only in the editor.", "diff-help"),
            diffView(version.source, app.source.value), makeButton("Back to history", showHistory));
        } catch (error) {
          app.status.textContent = error.message;
        }
      }), makeButton("Load into editor", () => {
        if (!app.canLeave()) return;
        app.source.replace(version.source);
        review.close();
        app.source.focus();
        app.status.textContent = "Version loaded. Save to restore it.";
      }));
      details.append(summary, actions, preview);
      item.append(details);
      versions.append(item);
    }
    openReview("Version history", versions);
  }

  async function showValues() {
    const id = app.selectedId;
    const values = await readValues(id);
    const entries = Object.entries(values);
    const content = entries.length ? element("dl", undefined, "stored-values") : element("p", "This script hasn’t stored any values yet.");
    for (const [name, value] of entries) content.append(element("dt", name), element("dd", JSON.stringify(value, null, 2)));
    openReview("Stored values", element("p", "Values saved with GM.setValue. They stay in this Chrome profile and aren’t included in backups."), content,
      ...(entries.length ? [makeButton("Clear stored values", () => {
        if (!confirm("Clear every value this script has stored? This can’t be undone.")) return;
        review.close();
        app.perform(async () => {
          await app.send({ type: "clear-values", id });
          app.status.textContent = "Stored values cleared.";
        });
      })] : []));
  }

  function showTrash() {
    const { trash } = app;
    const content = trash.length ? element("ul", undefined, "trash-list")
      : element("p", "The Trash is empty. Deleted scripts stay here for 30 days.");
    for (const script of trash) {
      const item = element("li");
      item.append(element("strong", script.name), element("span", ` deleted ${timeAgo(script.deletedAt)}`, "trash-age"),
        makeButton("Restore", () => {
          review.close();
          if (app.canLeave()) app.restore(script.id);
        }),
        makeButton("Delete forever", () => {
          if (!confirm(`Permanently delete “${script.name}” and its history? This can’t be undone.`)) return;
          app.perform(async () => {
            await app.send({ type: "purge", id: script.id });
            await app.reloadData();
            showTrash();
          });
        }));
      content.append(item);
    }
    openReview("Trash", element("p", "Deleted scripts are kept for 30 days, then removed with their history and stored values."), content,
      ...(trash.length ? [makeButton("Empty Trash", () => {
        if (!confirm(`Permanently delete ${trash.length} script(s)? This can’t be undone.`)) return;
        app.perform(async () => {
          await app.send({ type: "purge" });
          await app.reloadData();
          showTrash();
        });
      })] : []));
  }

  async function showSiteAccess() {
    const { origins = [] } = await chrome.permissions.getAll();
    const granted = origins.filter(origin => /^https?:|^\*:/.test(origin));
    const content = granted.length ? element("ul", undefined, "access-list")
      : element("p", "No sites have been granted yet. Saving an enabled script asks for access.");
    for (const origin of granted) {
      const users = app.scripts.filter(script => app.metadataFor(script)?.origins.includes(origin));
      const item = element("li");
      item.append(element("code", origin),
        element("span", users.length ? ` — used by ${users.map(script => script.name).join(", ")}` : " — not used by any script", "access-users"),
        makeButton("Remove access", async () => {
          const running = users.filter(script => script.enabled).length;
          if (running && !confirm(`${running} enabled script(s) will stop running on ${origin}. Remove access?`)) return;
          try {
            if (!await chrome.permissions.remove({ origins: [origin] })) throw new Error("Chrome kept this site access.");
            await showSiteAccess();
            app.status.textContent = `Removed access to ${origin}.`;
          } catch (error) {
            app.status.textContent = error.message;
          }
        }));
      content.append(item);
    }
    openReview("Site access", element("p", "Sites this extension may run scripts on. Removing access stops matching scripts until you save them enabled again."), content);
  }

  function settingSwitch(key, title, help) {
    return switchControl(title, help, Boolean(app.settings[key]), toggle => {
      review.close();
      app.sendSettings({ [key]: toggle.checked }).then(showBackup);
    });
  }

  function oneClickSwitch(granted) {
    return switchControl("One-click installs",
      "Opening a .user.js link on Greasy Fork, OpenUserJS or GitHub shows Tailorscript’s install page. Needs access to those sites.",
      granted, async toggle => {
        try {
          const changed = toggle.checked
            ? await chrome.permissions.request({ origins: installOrigins })
            : await chrome.permissions.remove({ origins: installOrigins });
          if (!changed) toggle.checked = !toggle.checked;
        } catch (error) {
          toggle.checked = !toggle.checked;
          app.status.textContent = error.message;
        }
      });
  }

  async function copyDiagnostics(button) {
    try {
      const report = formatDiagnostics(await app.send({ type: "diagnostics" }));
      await navigator.clipboard.writeText(report);
      button.textContent = "Copied";
    } catch (error) {
      app.status.textContent = `Couldn’t copy diagnostics: ${error.message}`;
    }
  }

  async function showBackup() {
    const { settings, syncState } = app;
    const [oneClick, commands] = await Promise.all([
      chrome.permissions.contains({ origins: installOrigins }),
      chrome.commands?.getAll() ?? []
    ]);
    const shortcut = commands.find(command => command.name === "toggle-pause")?.shortcut;
    const syncHelp = settings.syncBackup
      ? syncState?.error ? `Last attempt failed: ${syncState.error}` : syncState?.at ? `Last synced ${timeAgo(syncState.at)}.` : "Waiting for the next change."
      : "Stores script sources only (about 100 KB), not history, site access, or enabled settings.";
    const list = element("div", undefined, "settings-list");
    list.append(
      settingSwitch("reloadAfterSave", "Reload matching tabs after saving", "Open tabs that a saved script runs on reload so the change applies right away."),
      settingSwitch("syncBackup", "Back up to Chrome sync", syncHelp),
      oneClickSwitch(oneClick));
    const keys = element("p", shortcut ? `Press ${shortcut} anywhere in Chrome to pause or resume all scripts. ` : "Set a keyboard shortcut to pause or resume all scripts. ");
    keys.append(makeButton("Change shortcut", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })));
    const support = element("p", "Reporting a problem? Diagnostics list versions, settings and recent errors, never your scripts’ code. ");
    const copy = makeButton("Copy diagnostics", () => copyDiagnostics(copy));
    support.append(copy);
    openReview("Settings & backup", list, keys,
      element("p", settings.lastExportAt ? `Last exported ${new Date(settings.lastExportAt).toLocaleString()}.` : "You haven’t exported a backup file yet."),
      makeButton("Restore from Chrome sync", () => app.perform(async () => {
        const { text, savedAt } = await readSyncBackup();
        reviewImport(decodeImport(text, true), `Chrome sync (${new Date(savedAt).toLocaleString()})`);
      })), support);
  }

  function showInstallFromUrl() {
    const field = document.createElement("input");
    field.type = "url";
    field.placeholder = "https://greasyfork.org/…/script.user.js";
    field.setAttribute("aria-label", "Script address");
    const go = makeButton("Review script", () => {
      try {
        const url = new URL(field.value.trim());
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        review.close();
        chrome.tabs.create({ url: installPageUrl(url.href) });
      } catch {
        field.setCustomValidity("Enter an http or https address.");
        field.reportValidity();
      }
    });
    go.className = "primary";
    field.addEventListener("input", () => field.setCustomValidity(""));
    field.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) go.click();
    });
    const row = element("div", undefined, "url-row");
    row.append(field, go);
    openReview("Install from URL", element("p", "Paste the address of a .user.js file. You’ll see what it does before anything is installed."), row);
    field.focus();
  }

  $("#export", HTMLButtonElement).addEventListener("click", () => app.perform(async () => {
    const latest = await readScripts();
    if (!latest.length) throw new Error("There are no scripts to export.");
    downloadBackup({ version: 1, scripts: latest.map(({ source, history = [] }) => ({ source, history })) });
    await app.send({ type: "settings", patch: { lastExportAt: Date.now() } });
    await app.reloadData();
  }));
  $("#import", HTMLButtonElement).addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const [file] = importFile.files;
    importFile.value = "";
    if (!file) return;
    app.perform(async () => {
      reviewImport(decodeImport(await file.text(), file.name.toLowerCase().endsWith(".json")), file.name);
    });
  });
  $("#history", HTMLButtonElement).addEventListener("click", showHistory);
  $("#values", HTMLButtonElement).addEventListener("click", showValues);
  $("#trash", HTMLButtonElement).addEventListener("click", showTrash);
  $("#site-access", HTMLButtonElement).addEventListener("click", () => showSiteAccess().catch(error => {
    app.status.textContent = error.message;
  }));
  $("#backup", HTMLButtonElement).addEventListener("click", showBackup);
  $("#install-url", HTMLButtonElement).addEventListener("click", showInstallFromUrl);
}
