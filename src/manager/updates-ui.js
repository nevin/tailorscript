// Update status, review and checks in the manager.
import { $ } from "../shared/dom.js";
import { timeAgo } from "../shared/format.js";
import { describeGrants } from "../shared/install.js";
import { grantFamilies, parseSource } from "../shared/userscript.js";
import { diffView } from "./diff.js";
import { bulletList, element, makeButton, openReview, review, switchControl } from "./ui.js";

const updateState = $("#update-state");

export function setupUpdates(app) {
  function renderUpdateState(script) {
    updateState.replaceChildren();
    updateState.dataset.state = "";
    if (script?.pendingUpdate) {
      updateState.dataset.state = "available";
      updateState.append(`Version ${script.pendingUpdate.version} is available${script.pendingUpdate.reasons.length ? " and needs your review" : ""}.`,
        makeButton("Review update", () => reviewUpdate(script)));
    } else if (script?.updateCheck?.error) {
      updateState.dataset.state = "warning";
      updateState.append(`Update check failed ${timeAgo(script.updateCheck.at)}: ${script.updateCheck.error}`);
    }
  }

  function reviewUpdate(script) {
    const update = script.pendingUpdate;
    let next;
    try {
      next = parseSource(update.source);
    } catch (error) {
      app.status.textContent = error.message;
      return;
    }
    const apply = makeButton("Apply update", () => {
      review.close();
      app.perform(async () => {
        if (script.enabled && !await chrome.permissions.request({ origins: next.origins })) {
          throw new Error("Site access was declined, so the update wasn’t applied.");
        }
        await app.send({ type: "apply-update", id: script.id });
        await app.reloadData();
        const updated = app.scripts.find(item => item.id === script.id);
        if (script.id === app.selectedId && !app.isDirty()) app.select(updated);
        app.status.textContent = `Updated “${updated.name}” to v${update.version}. Reload matching pages to run it.`;
      });
    });
    apply.className = "primary";
    const actions = element("div", undefined, "dialog-actions");
    actions.append(apply, makeButton("Skip this version", () => {
      review.close();
      app.perform(async () => {
        await app.send({ type: "dismiss-update", id: script.id });
        await app.reloadData();
        app.status.textContent = `Skipped v${update.version}. Tailorscript will offer the next version.`;
      });
    }));
    openReview(`Update “${script.name}” to v${update.version}`,
      ...(update.reasons.length ? [element("p", "This update wasn’t applied automatically because:"), bulletList(update.reasons.map(text => ({ text })))] : []),
      element("p", "After updating, it can:"), bulletList(describeGrants(next, grantFamilies)),
      actions, element("p", "Changes:"), diffView(script.source, update.source));
  }

  function showUpdates() {
    const script = app.scripts.find(item => item.id === app.selectedId);
    if (!script) return;
    const metadata = app.metadataFor(script);
    const details = element("dl", undefined, "facts");
    const fact = (label, value) => details.append(element("dt", label), element("dd", value));
    fact("Installed from", script.installUrl ?? metadata?.updateUrl ?? "—");
    fact("Version", metadata?.version ? `v${metadata.version}` : "Not declared");
    fact("Last checked", script.updateCheck?.at ? timeAgo(script.updateCheck.at) : "Never");
    if (script.updateCheck?.error) fact("Last error", script.updateCheck.error);
    const settingsList = element("div", undefined, "settings-list");
    settingsList.append(switchControl("Update automatically",
      "Updates that need new access or APIs, or would replace your edits, always wait for your review.",
      script.autoUpdate !== false, toggle => app.perform(async () => {
        await app.send({ type: "auto-update", id: script.id, enabled: toggle.checked });
        await app.reloadData();
      })));
    const actions = element("div", undefined, "dialog-actions");
    actions.append(makeButton("Check now", () => {
      review.close();
      checkForUpdates(script.id);
    }));
    if (script.pendingUpdate) actions.prepend(makeButton(`Review v${script.pendingUpdate.version}`, () => reviewUpdate(script)));
    openReview("Updates", details, settingsList, actions);
  }

  function checkForUpdates(id) {
    return app.perform(async () => {
      app.status.textContent = "Checking for updates…";
      const { updateSummary: summary } = await app.send({ type: "check-updates", id });
      await app.reloadData();
      const fresh = app.scripts.find(item => item.id === app.selectedId);
      if (fresh && !app.isDirty() && fresh.source !== app.loaded?.source) app.select(fresh);
      const parts = [
        summary.updated.length && `updated ${summary.updated.join(", ")}`,
        summary.waiting.length && `${summary.waiting.length} waiting for review`,
        summary.failed.length && `${summary.failed.length} couldn’t be checked`
      ].filter(Boolean);
      app.status.textContent = !summary.checked ? "None of your scripts have an update address."
        : parts.length ? `Checked ${summary.checked} script${summary.checked === 1 ? "" : "s"}: ${parts.join(", ")}.`
        : `Checked ${summary.checked} script${summary.checked === 1 ? "" : "s"}. Everything is up to date.`;
    });
  }

  $("#updates", HTMLButtonElement).addEventListener("click", showUpdates);
  $("#check-updates", HTMLButtonElement).addEventListener("click", () => checkForUpdates());
  return { renderUpdateState };
}
