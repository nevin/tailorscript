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

// Changed lines with three lines of context; long unchanged runs collapse into one note.
export function diffView(before, after) {
  const rows = diffLines(before, after);
  const changed = rows.map(row => row.kind !== "same");
  if (!changed.some(Boolean)) {
    const same = document.createElement("p");
    same.textContent = "No changes.";
    return same;
  }
  const output = document.createElement("pre");
  output.className = "diff";
  const line = (text, className) => {
    const span = document.createElement("span");
    span.textContent = text;
    span.className = className;
    output.append(span);
  };
  const near = index => changed.slice(Math.max(0, index - 3), index + 4).some(Boolean);
  let hidden = 0;
  const flush = () => {
    if (hidden) line(`… ${hidden} unchanged line${hidden === 1 ? "" : "s"}\n`, "diff-skip");
    hidden = 0;
  };
  rows.forEach((row, index) => {
    if (!near(index)) {
      hidden++;
      return;
    }
    flush();
    line(`${{ same: " ", added: "+", removed: "-" }[row.kind]} ${row.text}\n`, `diff-${row.kind}`);
  });
  flush();
  return output;
}
