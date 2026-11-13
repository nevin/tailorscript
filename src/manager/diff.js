// Line-based LCS after trimming the shared prefix and suffix, which keeps typical edits small.
export function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > 4_000_000) throw new Error("These versions are too different to compare here.");
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const rows = a.slice(0, start).map(text => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      rows.push({ kind: "same", text: a[start + i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: "removed", text: a[start + i++] });
    } else {
      rows.push({ kind: "added", text: b[start + j++] });
    }
  }
  while (i < n) rows.push({ kind: "removed", text: a[start + i++] });
  while (j < m) rows.push({ kind: "added", text: b[start + j++] });
  return rows.concat(a.slice(endA).map(text => ({ kind: "same", text })));
}
