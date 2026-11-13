// Formats collectDiagnostics() output as plain text to paste into a bug report.
export function formatDiagnostics(data) {
  const lines = [
    `Tailorscript ${data.version}`,
    `Browser: ${data.browser}`,
    `Storage version: ${data.schemaVersion}`,
    `User scripts API: ${data.userScripts}`,
    `Paused: ${data.paused ? "yes" : "no"}`,
    `Scripts: ${data.scripts.total} saved, ${data.scripts.enabled} enabled, ${data.scripts.registered ?? "unknown"} registered`,
    `Site access: ${data.siteAccess.length ? data.siteAccess.join(", ") : "none"}`
  ];
  if (data.issues.length) lines.push("", "Registration issues:", ...data.issues.map(({ script, issue }) => `- ${script}: ${issue}`));
  if (data.recentErrors.length) {
    lines.push("", "Recent script errors:", ...data.recentErrors.map(({ script, message, line, at }) =>
      `- ${script}${line ? ` (line ${line})` : ""}: ${message} [${new Date(at).toISOString()}]`));
  }
  return lines.join("\n");
}
