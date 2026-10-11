// A1 notation helpers. Rows/cols are 0-based internally, end-exclusive (like Sheets GridRange).

export function colToIndex(col) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToCol(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

export function quoteSheet(title) {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

// Parses "Sheet1!B2:C10", "'My Sheet'!A1", "B:B", "A1". Returns
// { sheet, startRow, endRow, startCol, endCol } (endRow/endCol null = unbounded).
export function parseA1(a1) {
  if (typeof a1 !== 'string' || !a1.trim()) throw new Error('Range must be a non-empty A1 string');
  let sheet = null;
  let ref = a1.trim();
  const bang = ref.lastIndexOf('!');
  if (bang >= 0) {
    sheet = ref.slice(0, bang);
    ref = ref.slice(bang + 1);
    if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  const m = ref.replace(/\$/g, '').match(/^([A-Za-z]*)(\d*)(?::([A-Za-z]*)(\d*))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`Invalid A1 range: ${a1}`);
  const [, c1, r1, c2, r2] = m;
  const single = m[3] === undefined && m[4] === undefined;
  const startCol = c1 ? colToIndex(c1) : 0;
  const startRow = r1 ? Number(r1) - 1 : 0;
  let endCol, endRow;
  if (single) {
    endCol = c1 ? startCol + 1 : null;
    endRow = r1 ? startRow + 1 : null;
  } else {
    endCol = c2 ? colToIndex(c2) + 1 : (c1 ? null : null);
    endRow = r2 ? Number(r2) : null;
    if (!c2 && c1 && !r1) endCol = null;
  }
  if (r1 && Number(r1) < 1) throw new Error(`Invalid row in ${a1}`);
  if (endRow !== null && endRow <= startRow) throw new Error(`Range end before start: ${a1}`);
  if (endCol !== null && endCol <= startCol) throw new Error(`Range end before start: ${a1}`);
  return { sheet, startRow, endRow, startCol, endCol };
}

export function toA1({ sheet, startRow, endRow, startCol, endCol }) {
  const a = `${indexToCol(startCol)}${startRow + 1}`;
  const b = `${indexToCol(endCol - 1)}${endRow}`;
  const body = a === b ? a : `${a}:${b}`;
  return sheet ? `${quoteSheet(sheet)}!${body}` : body;
}

export function rangeSize(r) {
  return { rows: r.endRow - r.startRow, cols: r.endCol - r.startCol };
}

export function overlaps(a, b) {
  if ((a.sheet ?? null) !== (b.sheet ?? null)) return false;
  return a.startRow < b.endRow && b.startRow < a.endRow && a.startCol < b.endCol && b.startCol < a.endCol;
}

// Shift relative (non-$) row references in a formula by `delta` rows.
export function shiftFormulaRows(formula, delta) {
  return formula.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (all, col, abs, row) =>
    abs ? all : `${col}${Number(row) + delta}`);
}
