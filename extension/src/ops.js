// Allowlisted spreadsheet operations: validate → compile to concrete cell writes →
// preview (before/after) → execute exactly what was approved → verify → revert.

import { parseA1, toA1, indexToCol, colToIndex, quoteSheet, shiftFormulaRows } from './a1.js';
import { makeEvaluator, isoToSerial, serialToISO, forecastFormula } from './analysis.js';

export const OPERATION_TYPES = ['set_values', 'write_formula', 'format_range', 'append_forecast_rows', 'add_chart', 'add_sheet'];

// Functions that can send sheet data to the network or pull untrusted content in.
const BLOCKED_FUNCTIONS = new Set(['IMPORTXML', 'IMPORTHTML', 'IMPORTDATA', 'IMPORTFEED', 'IMPORTRANGE', 'IMAGE', 'HYPERLINK', 'WEBSERVICE', 'GOOGLEFINANCE', 'GOOGLETRANSLATE', 'DETECTLANGUAGE']);
const KNOWN_FUNCTIONS = new Set(`ABS AND AVERAGE AVERAGEIF AVERAGEIFS CEILING CHOOSE COLUMN COLUMNS CONCAT CONCATENATE COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS DATE DATEDIF DAY DAYS EDATE EOMONTH EXP FILTER FLOOR FORECAST FORECAST.LINEAR GROWTH IF IFERROR IFNA IFS INDEX INT ISBLANK ISERROR ISNUMBER LARGE LEFT LEN LINEST LN LOG LOG10 LOOKUP LOWER MATCH MAX MAXIFS MEDIAN MID MIN MINIFS MOD MONTH NETWORKDAYS NOT NOW NPV IRR XIRR XNPV PMT FV PV RATE OFFSET OR PERCENTILE POWER PRODUCT QUARTER RANK RIGHT ROUND ROUNDDOWN ROUNDUP ROW ROWS SEQUENCE SIGN SLOPE INTERCEPT RSQ SMALL SORT SQRT STDEV SUBSTITUTE SUM SUMIF SUMIFS SUMPRODUCT SWITCH TEXT TODAY TREND TRIM UNIQUE UPPER VALUE VLOOKUP HLOOKUP XLOOKUP WEEKDAY YEAR ARRAYFORMULA LET`.split(/\s+/));

// Sheets' fill-color palette (aria-labels of the swatches). Requested colors snap to the nearest.
const PALETTE = {
  'white': '#ffffff', 'light gray 3': '#f3f3f3', 'light gray 2': '#efefef', 'light gray 1': '#d9d9d9', 'gray': '#cccccc',
  'light red 3': '#f4cccc', 'light orange 3': '#fce5cd', 'light yellow 3': '#fff2cc', 'light green 3': '#d9ead3', 'light cyan 3': '#d0e0e3',
  'light cornflower blue 3': '#c9daf8', 'light blue 3': '#cfe2f3', 'light purple 3': '#d9d2e9', 'light magenta 3': '#ead1dc',
  'light red 2': '#ea9999', 'light orange 2': '#f9cb9c', 'light yellow 2': '#ffe599', 'light green 2': '#b6d7a8', 'light cyan 2': '#a2c4c9',
  'light cornflower blue 2': '#a4c2f4', 'light blue 2': '#9fc5e8', 'light purple 2': '#b4a7d6', 'light magenta 2': '#d5a6bd',
  'red': '#ff0000', 'orange': '#ff9900', 'yellow': '#ffff00', 'green': '#00ff00', 'cyan': '#00ffff', 'cornflower blue': '#4a86e8', 'blue': '#0000ff',
};
export const FORECAST_FILL = 'light blue 3';
function nearestPalette(hex) {
  const c = hexToRgb(hex);
  let best = null, bd = Infinity;
  for (const [name, h] of Object.entries(PALETTE)) {
    const p = hexToRgb(h);
    const d = (p.red - c.red) ** 2 + (p.green - c.green) ** 2 + (p.blue - c.blue) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

export function validateFormula(formula, knownSheets) {
  const errors = [];
  if (typeof formula !== 'string' || !formula.startsWith('=')) errors.push('Formula must start with "="');
  else {
    let depth = 0, inStr = false;
    for (const ch of formula) {
      if (ch === '"') inStr = !inStr;
      else if (!inStr && ch === '(') depth++;
      else if (!inStr && ch === ')') { depth--; if (depth < 0) break; }
    }
    if (inStr) errors.push('Unbalanced quotes');
    if (depth !== 0) errors.push('Unbalanced parentheses');
    const noStrings = formula.replace(/"[^"]*"/g, '""');
    for (const m of noStrings.matchAll(/([A-Za-z][A-Za-z0-9_.]*)\s*\(/g)) {
      const fn = m[1].toUpperCase();
      if (BLOCKED_FUNCTIONS.has(fn)) errors.push(`${fn} is not allowed (network access / exfiltration risk)`);
      else if (!KNOWN_FUNCTIONS.has(fn)) errors.push(`Unknown or unsupported function ${fn}`);
    }
    for (const m of noStrings.matchAll(/(?:'((?:[^']|'')+)'|([A-Za-z0-9_]+))!/g)) {
      const s = (m[1] ?? m[2]).replace(/''/g, "'");
      if (!knownSheets.has(s)) errors.push(`Formula references unknown sheet "${s}"`);
    }
    if (/#REF!|#N\/A|#VALUE!|#DIV\/0!|#NAME\?/.test(noStrings)) errors.push('Formula contains an error literal');
  }
  return errors;
}

function rgbToHex(c) {
  if (!c) return null;
  const h = v => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

const NUMBER_FORMATS = ['currency', 'percent', 'number', 'date', 'plain'];

// ctx: { spreadsheetId, meta, sheetsByTitle: Map, grids: Map<title, grid>, forecasts: {id: forecast} }
export function compileOperation(ctx, input, index, planState) {
  const op = { index, input, kind: input?.op, summary: '', writes: [], formatRequests: [], chart: null, newSheet: null, errors: [], warnings: [] };
  const knownSheets = planState.knownSheets;
  const defaultSheet = ctx.activeSheetTitle;

  const resolveRange = a1 => {
    const r = parseA1(a1);
    r.sheet ??= defaultSheet;
    if (!knownSheets.has(r.sheet)) throw new Error(`Sheet "${r.sheet}" does not exist`);
    if (r.endRow === null || r.endCol === null) throw new Error(`Range ${a1} must be bounded (e.g. F2:F10, not F:F)`);
    if ((r.endRow - r.startRow) * (r.endCol - r.startCol) > 5000) throw new Error(`Range ${a1} too large (max 5000 cells per operation)`);
    return r;
  };
  const before = (sheet, row, col) => {
    const g = ctx.grids.get(sheet);
    const c = g?.cells[row - g.startRow]?.[col - g.startCol];
    return c ? { value: c.v, formula: c.f, text: c.t, uev: c.uev ?? null, numberFormat: c.uef?.numberFormat ?? null, textFormat: c.uef?.textFormat ?? null, backgroundColor: c.uef?.backgroundColor ?? null } : { value: null, formula: null, text: '', uev: null };
  };
  const addWrite = (sheet, row, col, content) => {
    const key = `${sheet}!${row}:${col}`;
    if (planState.written.has(key)) op.errors.push(`Cell ${toA1({ sheet, startRow: row, endRow: row + 1, startCol: col, endCol: col + 1 })} is written by more than one operation`);
    planState.written.add(key);
    const b = before(sheet, row, col);
    const isFormula = typeof content === 'string' && content.startsWith('=');
    const w = { sheet, row, col, a1: toA1({ sheet, startRow: row, endRow: row + 1, startCol: col, endCol: col + 1 }), kind: isFormula ? 'formula' : 'value', content, before: b };
    op.writes.push(w);
    planState.cellMap.set(key, w);
    return w;
  };

  try {
    if (!OPERATION_TYPES.includes(op.kind)) throw new Error(`Unsupported operation "${op.kind}". Allowed: ${OPERATION_TYPES.join(', ')}`);

    if (op.kind === 'add_sheet') {
      const title = String(input.title ?? '').trim();
      if (!title || title.length > 90) throw new Error('add_sheet requires a title (≤ 90 chars)');
      if (knownSheets.has(title)) throw new Error(`Sheet "${title}" already exists`);
      knownSheets.add(title);
      planState.newSheets.add(title);
      op.newSheet = title;
      op.summary = `Add new tab "${title}"`;
    }

    if (op.kind === 'set_values') {
      const r = resolveRange(input.range);
      const vals = input.values;
      const rows = r.endRow - r.startRow, cols = r.endCol - r.startCol;
      if (!Array.isArray(vals) || vals.length !== rows || vals.some(v => !Array.isArray(v) || v.length !== cols)) {
        throw new Error(`values must be a ${rows}x${cols} 2D array to match ${input.range}`);
      }
      vals.forEach((row, ri) => row.forEach((v, ci) => {
        if (typeof v === 'string' && v.startsWith('=')) throw new Error('set_values cannot write formulas; use write_formula');
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new Error('values must be strings, numbers, booleans or null');
        addWrite(r.sheet, r.startRow + ri, r.startCol + ci, v);
      }));
      op.summary = `Write ${rows * cols} value(s) to ${toA1(r)}`;
    }

    if (op.kind === 'write_formula') {
      const r = resolveRange(input.range);
      const tpl = String(input.formula ?? '');
      const errs = validateFormula(tpl.replaceAll('{row}', '1'), knownSheets);
      if (errs.length) throw new Error(`Invalid formula ${tpl}: ${errs.join('; ')}`);
      for (let row = r.startRow; row < r.endRow; row++)
        for (let col = r.startCol; col < r.endCol; col++)
          addWrite(r.sheet, row, col, tpl.replaceAll('{row}', String(row + 1)));
      op.summary = `Fill ${toA1(r)} with ${tpl}`;
    }

    if (op.kind === 'format_range') {
      const r = resolveRange(input.range);
      const parts = [];
      if (input.number_format) {
        if (!NUMBER_FORMATS.includes(input.number_format)) throw new Error(`number_format must be one of ${NUMBER_FORMATS.join(', ')}`);
        const decimals = input.decimals === undefined ? undefined : Math.max(0, Math.min(4, Number(input.decimals)));
        op.formatRequests.push({ kind: 'number', sheet: r.sheet, range: r, format: input.number_format, decimals, label: `${input.number_format}${decimals !== undefined ? ` (${decimals} dp)` : ''}` });
        parts.push(input.number_format);
      }
      for (const prop of ['bold', 'italic']) if (input[prop] !== undefined) {
        op.formatRequests.push({ kind: 'text', sheet: r.sheet, range: r, prop, value: !!input[prop], label: `${input[prop] ? '' : 'not '}${prop}` });
        parts.push(`${input[prop] ? '' : 'not '}${prop}`);
      }
      if (input.background) {
        if (!hexToRgb(input.background)) throw new Error('background must be a hex color like #cfe2f3');
        const palette = nearestPalette(input.background);
        op.formatRequests.push({ kind: 'fill', sheet: r.sheet, range: r, palette, label: `fill "${palette}" (${PALETTE[palette]})` });
        parts.push(`fill ${palette}`);
        if (PALETTE[palette] !== input.background.toLowerCase()) op.warnings.push(`Background ${input.background} uses the nearest Sheets palette color "${palette}" (${PALETTE[palette]})`);
      }
      if (!op.formatRequests.length) throw new Error('format_range needs number_format, bold, italic or background');
      op.formatTargets = [r];
      op.summary = `Format ${toA1(r)}: ${parts.join(', ')}`;
    }

    if (op.kind === 'append_forecast_rows') {
      const fc = ctx.forecasts[input.forecast_id];
      if (!fc) throw new Error(`Unknown forecast_id "${input.forecast_id}". Call forecast first.`);
      if (fc.spreadsheetId !== ctx.spreadsheetId) throw new Error('Forecast belongs to a different spreadsheet');
      const g = ctx.grids.get(fc.sheet);
      if (g && g.hash !== fc.sourceHash) throw new Error('Sheet data changed since this forecast was computed. Re-run forecast.');
      const sheet = fc.sheet;
      const firstNew = fc.lastActualRow; // 0-based index of first new row == 1-based last actual row
      // Rows must be empty.
      for (let i = 0; i < fc.periods; i++) {
        const rowCells = g?.cells[firstNew + i - g.startRow] ?? [];
        if (rowCells.some(c => c && (c.v !== null || c.f))) throw new Error(`Row ${firstNew + i + 1} is not empty; cannot append forecast rows there.`);
      }
      // Period labels
      if (fc.periodColumn) {
        const pc = colToIndex(fc.periodColumn);
        fc.periodLabels.forEach((iso, i) => { if (iso) addWrite(sheet, firstNew + i, pc, iso); });
      }
      // Forecast values as reproducible formulas.
      for (const s of fc.series) {
        const ci = colToIndex(s.letter);
        s.projections.forEach((_, i) => {
          const targetRow = firstNew + i + 1;
          const f = forecastFormula(fc.method, { letter: s.letter, firstDataRow: fc.firstDataRow, lastActualRow: fc.lastActualRow, targetRow, window: fc.window, params: s.params });
          addWrite(sheet, firstNew + i, ci, f);
        });
      }
      // Extend formula columns (e.g. Profit = B-C) into forecast rows.
      if (input.extend_formula_columns !== false) {
        for (const col of fc.formulaColumns ?? []) {
          if (fc.series.some(s => s.letter === col.letter)) continue;
          const ci = colToIndex(col.letter);
          for (let i = 0; i < fc.periods; i++) addWrite(sheet, firstNew + i, ci, shiftFormulaRows(col.lastFormula, i + 1));
        }
      }
      // Distinguish actuals and projections.
      if (input.mark_type_column !== false) {
        let typeCol = fc.typeColumn ? colToIndex(fc.typeColumn) : null;
        if (typeCol === null) {
          typeCol = fc.nextEmptyCol;
          addWrite(sheet, fc.headerRow - 1, typeCol, 'Type');
          for (let r = fc.firstDataRow; r <= fc.lastActualRow; r++) addWrite(sheet, r - 1, typeCol, 'Actual');
        }
        for (let i = 0; i < fc.periods; i++) addWrite(sheet, firstNew + i, typeCol, 'Forecast');
      }
      const lastCol = Math.max(...op.writes.map(w => w.col)) + 1;
      const fr = { sheet, startRow: firstNew, endRow: firstNew + fc.periods, startCol: 0, endCol: lastCol };
      // Formats are copied from the last actual row first (dates/currency render consistently), then projections are marked.
      const src = { sheet, startRow: fc.lastActualRow - 1, endRow: fc.lastActualRow, startCol: 0, endCol: lastCol };
      op.formatRequests.push({ kind: 'copyFormat', sheet, range: fr, source: src, label: `formats copied from row ${fc.lastActualRow}` });
      op.formatRequests.push({ kind: 'text', sheet, range: fr, prop: 'italic', value: true, label: 'italic' });
      op.formatRequests.push({ kind: 'fill', sheet, range: fr, palette: FORECAST_FILL, label: `fill "${FORECAST_FILL}" (projection rows)` });
      op.formatTargets = [fr];
      op.forecast = { id: fc.id, method: fc.method, assumptions: fc.assumptions };
      op.summary = `Append ${fc.periods} forecast row(s) (${fc.method.replace('_', ' ')}) to ${quoteSheet(sheet)} rows ${firstNew + 1}-${firstNew + fc.periods}`;
    }

    if (op.kind === 'add_chart') {
      const type = String(input.chart_type ?? 'line').toUpperCase();
      if (!['LINE', 'COLUMN', 'BAR'].includes(type)) throw new Error('chart_type must be line, column or bar');
      const domain = resolveRange(input.domain_range);
      const series = (input.series_ranges ?? []).map(resolveRange);
      if (!series.length) throw new Error('add_chart needs at least one series range');
      for (const r of [domain, ...series]) {
        if (r.endCol - r.startCol !== 1) throw new Error(`Chart ranges must be single columns: ${toA1(r)}`);
        if (r.sheet !== domain.sheet) throw new Error('All chart ranges must be on the same sheet');
        if (r.startRow !== domain.startRow || r.endRow !== domain.endRow) throw new Error(`Series ${toA1(r)} must span the same rows as the domain ${toA1(domain)}`);
      }
      const g = ctx.grids.get(domain.sheet);
      // Validate the ranges contain data (current or planned).
      const hasData = (r, row) => { const p = planState.cellMap.get(`${r.sheet}!${row}:${r.startCol}`); const c = g?.cells[row - (g?.startRow ?? 0)]?.[r.startCol - (g?.startCol ?? 0)]; return !!p || (c && c.v !== null); };
      for (const r of series) {
        let numeric = 0;
        for (let row = r.startRow + (input.has_header === false ? 0 : 1); row < r.endRow; row++) if (hasData(r, row)) numeric++;
        if (!numeric) throw new Error(`Series ${toA1(r)} has no data`);
      }
      let anchor = input.anchor_cell ? resolveRange(input.anchor_cell) : { sheet: domain.sheet, startRow: domain.startRow, startCol: Math.max(...series.map(s => s.endCol)) + 2 };
      const title = String(input.title ?? 'Chart').slice(0, 100);
      op.chart = { type, title, domain, series, anchor, headerCount: input.has_header === false ? 0 : 1 };
      op.summary = `Add ${type.toLowerCase()} chart "${title}" from ${toA1(domain)} vs ${series.map(toA1).join(', ')}`;
    }

    // Overwrite policy: writes to non-empty cells need allow_overwrite.
    const overwrites = op.writes.filter(w => w.before.value !== null || w.before.formula);
    if (overwrites.length && op.kind !== 'append_forecast_rows') {
      if (input.allow_overwrite) op.warnings.push(`Overwrites ${overwrites.length} non-empty cell(s): ${overwrites.slice(0, 5).map(w => w.a1).join(', ')}${overwrites.length > 5 ? '…' : ''}`);
      else throw new Error(`Would overwrite ${overwrites.length} non-empty cell(s) (${overwrites.slice(0, 3).map(w => w.a1).join(', ')}…). Set allow_overwrite: true if intended.`);
    }
    // Protected ranges.
    for (const w of op.writes) {
      for (const p of planState.protectedRanges) {
        if (p.sheet === w.sheet && w.row >= p.startRow && w.row < p.endRow && w.col >= p.startCol && w.col < p.endCol)
          throw new Error(`${w.a1} is in a protected range you cannot edit${p.description ? ` (${p.description})` : ''}`);
      }
    }
  } catch (e) {
    op.errors.push(e.message);
  }
  return op;
}

// Expected values for previews, evaluated deterministically over current + planned cells.
export function computeExpected(ctx, planState, ops) {
  const memo = new Map();
  const lookupFor = sheet => (col, row1) => {
    const key = `${sheet}!${row1 - 1}:${col}`;
    if (memo.has(key)) return memo.get(key);
    const planned = planState.cellMap.get(key);
    let v;
    if (planned) {
      if (planned.kind === 'formula') {
        memo.set(key, NaN); // cycle guard
        try { v = makeEvaluator(lookupFor(sheet))(planned.content); } catch { v = NaN; }
      } else v = typeof planned.content === 'number' ? planned.content : (planned.content === null ? null : NaN);
    } else {
      const g = ctx.grids.get(sheet);
      const c = g?.cells[row1 - 1 - g.startRow]?.[col - g.startCol];
      v = typeof c?.v === 'number' ? c.v : (c?.v == null ? null : NaN);
    }
    memo.set(key, v);
    return v;
  };
  for (const op of ops) for (const w of op.writes) {
    if (w.kind !== 'formula') continue;
    try {
      const v = makeEvaluator(lookupFor(w.sheet))(w.content);
      w.expected = Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    } catch (e) {
      w.expected = null;
      w.expectedNote = /DIV\/0/.test(e.message) ? 'would produce #DIV/0!' : 'computed by Sheets after execution';
      if (/DIV\/0/.test(e.message)) op.warnings.push(`${w.a1}: ${w.content} would divide by zero`);
    }
  }
}

const a1Body = r => toA1({ ...r, sheet: null });
const boundingBox = (sheet, cells) => {
  const rs = cells.map(c => c.row), cs = cells.map(c => c.col);
  return { sheet, startRow: Math.min(...rs), endRow: Math.max(...rs) + 1, startCol: Math.min(...cs), endCol: Math.max(...cs) + 1 };
};

// All cells an op touches (writes + format targets), grouped as one bounding box per sheet.
export function opFootprint(op) {
  const bySheet = new Map();
  for (const w of op.writes) (bySheet.get(w.sheet) ?? bySheet.set(w.sheet, []).get(w.sheet)).push({ row: w.row, col: w.col });
  for (const r of op.formatTargets ?? []) {
    const arr = bySheet.get(r.sheet) ?? bySheet.set(r.sheet, []).get(r.sheet);
    arr.push({ row: r.startRow, col: r.startCol }, { row: r.endRow - 1, col: r.endCol - 1 });
  }
  return [...bySheet].map(([sheet, cells]) => boundingBox(sheet, cells));
}

// Contiguous runs of writes per row → one paste each.
function writeRuns(writes) {
  const rows = new Map();
  for (const w of writes) {
    const k = `${w.sheet}\u0000${w.row}`;
    (rows.get(k) ?? rows.set(k, []).get(k)).push(w);
  }
  const runs = [];
  for (const ws of rows.values()) {
    ws.sort((a, b) => a.col - b.col);
    let run = [ws[0]];
    for (const w of ws.slice(1)) {
      if (w.col === run.at(-1).col + 1) run.push(w); else { runs.push(run); run = [w]; }
    }
    runs.push(run);
  }
  // Merge vertically adjacent runs with identical column spans into rectangular blocks.
  runs.sort((a, b) => a[0].sheet.localeCompare(b[0].sheet) || a[0].col - b[0].col || a.length - b.length || a[0].row - b[0].row);
  const blocks = [];
  for (const run of runs) {
    const last = blocks.at(-1);
    const prev = last?.at(-1);
    if (prev && prev[0].sheet === run[0].sheet && prev[0].col === run[0].col && prev.length === run.length && prev[0].row + 1 === run[0].row) last.push(run);
    else blocks.push([run]);
  }
  return blocks;
}

const typed = v => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

// Executes approved ops in order by operating the Sheets page (ctx.drv). Each op snapshots its
// footprint first (full clipboard payload) so it can be reverted exactly.
export async function executeOps(ctx, plan, approvedIndexes) {
  const results = [];
  let failed = false;
  for (const op of plan.ops) {
    if (!approvedIndexes.includes(op.index)) { results.push({ index: op.index, status: 'skipped_not_approved' }); continue; }
    if (failed) { results.push({ index: op.index, status: 'not_attempted', reason: 'an earlier operation failed' }); continue; }
    const res = { index: op.index, status: 'pending', started_at: Date.now(), steps: [] };
    try {
      if (op.newSheet) {
        await ctx.drv('addSheet', { title: op.newSheet });
        res.created_sheet = op.newSheet;
        res.steps.push(`added tab ${op.newSheet}`);
      }
      op.snapshots = [];
      if (!op.newSheet) {
        for (const box of opFootprint(op)) {
          const payload = await ctx.drv('snapshot', { sheet: box.sheet, range: a1Body(box) });
          op.snapshots.push({ sheet: box.sheet, range: a1Body(box), payload });
        }
      }
      // Copy formats (append_forecast_rows): paste the source row's full payload, then clear contents.
      for (const f of op.formatRequests.filter(f => f.kind === 'copyFormat')) {
        const payload = await ctx.drv('snapshot', { sheet: f.sheet, range: a1Body(f.source) });
        for (let row = f.range.startRow; row < f.range.endRow; row++) {
          const target = a1Body({ startRow: row, endRow: row + 1, startCol: f.range.startCol, endCol: f.range.endCol });
          await ctx.drv('restore', { sheet: f.sheet, range: target, payload });
          await ctx.drv('clearRange', { sheet: f.sheet, range: target });
        }
        res.steps.push(f.label);
      }
      for (const block of writeRuns(op.writes)) {
        const first = block[0][0];
        const r = { startRow: first.row, endRow: first.row + block.length, startCol: first.col, endCol: first.col + block[0].length };
        if (block.flat().every(w => w.content === null || w.content === undefined || w.content === '')) await ctx.drv('clearRange', { sheet: first.sheet, range: a1Body(r) });
        else await ctx.drv('pasteBlock', { sheet: first.sheet, range: a1Body(r), rows: block.map(run => run.map(w => typed(w.content))) });
      }
      if (op.writes.length) res.steps.push(`wrote ${op.writes.length} cell(s)`);
      for (const f of op.formatRequests.filter(f => f.kind !== 'copyFormat')) {
        const range = a1Body(f.range);
        if (f.kind === 'number') await ctx.drv('numberFormat', { sheet: f.sheet, range, kind: f.format, decimals: f.decimals });
        else if (f.kind === 'text') await ctx.drv('textStyle', { sheet: f.sheet, range, prop: f.prop, value: f.value });
        else if (f.kind === 'fill') await ctx.drv('fillColor', { sheet: f.sheet, range, palette: f.palette });
        res.steps.push(f.label);
      }
      if (op.chart) {
        const c = op.chart;
        const ranges = [c.domain, ...c.series].map(a1Body).join(',');
        const chart = await ctx.drv('insertChart', { sheet: c.domain.sheet, ranges, type: c.type, anchor: { row: c.anchor.startRow, col: c.anchor.startCol }, title: c.title });
        res.chart = { sheet: c.domain.sheet, key: chart.key, type: chart.type, range: chart.range };
        if (chart.warning) res.warnings = [chart.warning];
        res.steps.push(`inserted ${chart.type ?? 'chart'}`);
      }
      res.status = 'succeeded';
    } catch (e) {
      res.status = 'failed';
      res.error = e.message;
      failed = true;
    }
    res.finished_at = Date.now();
    results.push(res);
  }
  return results;
}

function sameText(a, b) {
  return String(a ?? '').replace(/\s/g, '').toUpperCase() === String(b ?? '').replace(/\s/g, '').toUpperCase();
}

// Re-reads written cells and checks they hold what was approved.
export function verifyWrites(plan, results, gridsAfter) {
  const checks = [];
  for (const op of plan.ops) {
    const r = results.find(x => x.index === op.index);
    if (r?.status !== 'succeeded') continue;
    for (const w of op.writes) {
      const g = gridsAfter.get(w.sheet);
      const c = g?.cells[w.row - g.startRow]?.[w.col - g.startCol];
      const issues = [];
      if (w.content === null || w.content === '') {
        if (c && (c.v !== null || c.f)) issues.push('expected empty');
      } else if (!c || (c.v === null && !c.f && !c.err)) issues.push('cell is empty after write');
      else {
        if (c.err) issues.push(`Sheets shows error #${c.err}`);
        if (w.kind === 'formula' && !sameText(c.f, w.content)) issues.push(`formula is ${c.f ?? '(none)'}, expected ${w.content}`);
        if (w.kind === 'formula' && Number.isFinite(w.expected) && typeof c.v === 'number' && Math.abs(c.v - w.expected) > Math.max(0.011, Math.abs(w.expected) * 1e-6)) issues.push(`value ${c.v} differs from independently computed ${w.expected}`);
        if (w.kind === 'value') {
          if (typeof w.content === 'number' && c.v !== w.content) issues.push(`value is ${c.v}, expected ${w.content}`);
          if (typeof w.content === 'string') {
            const asDate = c.fmt?.type?.startsWith('DATE') && typeof c.v === 'number' ? serialToISO(c.v) : null;
            if (c.v !== w.content && c.t !== w.content && asDate !== w.content) issues.push(`shows "${c.t}", expected "${w.content}"`);
          }
        }
      }
      w.after = c ? { value: c.v, formula: c.f, text: c.t } : null;
      if (issues.length) checks.push({ cell: w.a1, issues });
    }
    for (const f of op.formatRequests) {
      if (f.kind !== 'number' && f.kind !== 'text') continue;
      const g = gridsAfter.get(f.sheet);
      if (!g) continue;
      const bad = [];
      for (let row = f.range.startRow; row < f.range.endRow; row++) for (let col = f.range.startCol; col < f.range.endCol; col++) {
        const c = g.cells[row - g.startRow]?.[col - g.startCol];
        if (!c || (c.v === null && !c.f)) continue;
        if (f.kind === 'text' && (c.style?.[f.prop] ?? false) !== f.value) bad.push(toA1({ sheet: null, startRow: row, endRow: row + 1, startCol: col, endCol: col + 1 }));
        if (f.kind === 'number' && f.format !== 'plain' && typeof c.v === 'number' && !({ currency: /CURRENCY/, percent: /PERCENT/, number: /NUMBER|CURRENCY/, date: /DATE/ }[f.format]?.test(c.fmt?.type ?? ''))) bad.push(toA1({ sheet: null, startRow: row, endRow: row + 1, startCol: col, endCol: col + 1 }));
      }
      if (bad.length) checks.push({ cell: `${f.sheet}!${bad.slice(0, 3).join(',')}${bad.length > 3 ? '…' : ''}`, issues: [`${f.label} not applied`] });
    }
  }
  // Record each snapshot box's post-execution state so revert can detect any later change inside it.
  for (const op of plan.ops) for (const snap of op.snapshots ?? []) snap.after = boxState(gridsAfter.get(snap.sheet), snap.range);
  return { ok: checks.length === 0, issues: checks, checked_cells: plan.ops.reduce((a, o) => a + o.writes.length, 0) };
}

function boxState(g, range) {
  const r = parseA1(range);
  const out = [];
  for (let row = r.startRow; row < r.endRow; row++) {
    const line = [];
    for (let col = r.startCol; col < r.endCol; col++) {
      const c = g?.cells[row - g.startRow]?.[col - g.startCol];
      line.push(c?.f ?? c?.v ?? null);
    }
    out.push(line);
  }
  return out;
}

// Revert executed ops in reverse: paste back each footprint snapshot, remove created charts/tabs.
export async function revertOps(ctx, plan, { force = false } = {}) {
  // Includes failed ops: they may have partially written before failing (their snapshot covers it).
  const executed = plan.ops.filter(o => plan.execution?.results?.find(r => r.index === o.index && (r.status === 'succeeded' || (r.status === 'failed' && (o.snapshots?.length || r.created_sheet || r.chart)))));
  const conflicts = [];
  for (const op of executed) for (const snap of op.snapshots ?? []) {
    if (!snap.after) { conflicts.push(`${snap.sheet}!${snap.range} (post-execution state unknown)`); continue; }
    if (!ctx.grids.has(snap.sheet)) continue;
    const now = boxState(ctx.grids.get(snap.sheet), snap.range);
    const r = parseA1(snap.range);
    snap.after.forEach((line, i) => line.forEach((v, j) => {
      const cur = now[i][j];
      const same = typeof v === 'string' && typeof cur === 'string' ? sameText(v, cur) : v === cur;
      if (!same) conflicts.push(toA1({ sheet: snap.sheet, startRow: r.startRow + i, endRow: r.startRow + i + 1, startCol: r.startCol + j, endCol: r.startCol + j + 1 }));
    }));
  }
  if (conflicts.length && !force) return { ok: false, conflicts, message: `${conflicts.length} cell(s) changed since execution: ${conflicts.slice(0, 5).join(', ')}` };
  const restored = [], removedCharts = [], deletedSheets = [], manual = [];
  for (const op of [...executed].reverse()) {
    const res = plan.execution.results.find(r => r.index === op.index);
    if (res.chart) {
      try { await ctx.drv('deleteChart', { sheet: res.chart.sheet, key: res.chart.key }); removedCharts.push(res.chart.key.label || 'chart'); }
      catch (e) { manual.push(`Delete chart "${res.chart.key.label}" on ${res.chart.sheet} manually (${e.message})`); }
    }
    if (res.created_sheet) { await ctx.drv('deleteSheet', { title: res.created_sheet }); deletedSheets.push(res.created_sheet); continue; }
    for (const snap of op.snapshots ?? []) {
      await ctx.drv('restore', { sheet: snap.sheet, range: snap.range, payload: snap.payload });
      restored.push(`${snap.sheet}!${snap.range}`);
    }
  }
  return { ok: true, restored_cells: executed.reduce((a, o) => a + o.writes.length, 0), restored_ranges: restored, deleted_sheets: deletedSheets, removed_charts: removedCharts, manual_steps: manual, forced: conflicts.length > 0 };
}

export { serialToISO, isoToSerial, indexToCol, hexToRgb, rgbToHex };
