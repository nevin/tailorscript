const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(at) {
  const seconds = Math.round((at - Date.now()) / 1000);
  for (const [unit, size] of /** @type {[Intl.RelativeTimeFormatUnit, number][]} */ ([["day", 86_400], ["hour", 3_600], ["minute", 60]])) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(seconds, "second");
}
