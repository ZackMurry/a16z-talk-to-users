// Deterministic spreadsheet understanding and financial arithmetic.
// Nothing here calls a model: every number returned to the agent is computed here
// (or by Sheets itself) and cites the cells it came from.

import { indexToCol, colToIndex, quoteSheet } from './a1.js';

const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
export const serialToISO = s => new Date(SERIAL_EPOCH + Math.round(s * 86400000)).toISOString().slice(0, 10);
export const isoToSerial = iso => (Date.parse(iso + 'T00:00:00Z') - SERIAL_EPOCH) / 86400000;

export function normalizeCell(c) {
  if (!c) return { v: null, f: null, t: '', fmt: null, err: null };
  const ev = c.effectiveValue ?? {};
  const err = ev.errorValue ? (ev.errorValue.type ?? 'ERROR') : null;
  const v = ev.numberValue ?? ev.stringValue ?? ev.boolValue ?? null;
  const fmt = c.effectiveFormat?.numberFormat ?? null;
  return {
    v,
    f: c.userEnteredValue?.formulaValue ?? null,
    t: c.formattedValue ?? '',
    fmt: fmt ? { type: fmt.type, pattern: fmt.pattern ?? '' } : null,
    err,
    uev: c.userEnteredValue ?? null,
    uef: c.userEnteredFormat ?? null,
  };
}

// grid: API response for a single range. Returns a dense 2D array of normalized cells
// anchored at (startRow, startCol), trimmed of trailing empty rows/cols.
export function gridToCells(gridResponse) {
  const sheet = gridResponse.sheets[0];
  const data = sheet.data[0] ?? {};
  const rows = (data.rowData ?? []).map(r => (r.values ?? []).map(normalizeCell));
  const isEmpty = c => c.v === null && !c.f && !c.err;
  while (rows.length && rows.at(-1).every(isEmpty)) rows.pop();
  const width = Math.max(0, ...rows.map(r => { let w = r.length; while (w && isEmpty(r[w - 1])) w--; return w; }));
  const cells = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? normalizeCell(null)));
  return { sheetTitle: sheet.properties.title, sheetId: sheet.properties.sheetId, startRow: data.startRow ?? 0, startCol: data.startColumn ?? 0, cells };
}

const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-']*(\d{2,4})?$/i;
const QUARTER_RE = /^(q[1-4])[\s\-']*(fy)?\s*(\d{2,4})?$|^(fy)?\s*\d{2,4}[\s\-]*q[1-4]$/i;

function cellKind(c) {
  if (c.err) return 'error';
  if (c.v === null) return 'empty';
  if (typeof c.v === 'number') {
    const t = c.fmt?.type;
    if (t === 'DATE' || t === 'DATE_TIME') return 'date';
    if (t === 'CURRENCY' || /[$€£¥₹]/.test(c.fmt?.pattern ?? '')) return 'currency';
    if (t === 'PERCENT') return 'percent';
    return 'number';
  }
  if (typeof c.v === 'string') {
    if (MONTH_RE.test(c.v.trim()) || QUARTER_RE.test(c.v.trim()) || /^\d{4}-\d{2}(-\d{2})?$/.test(c.v.trim())) return 'period_text';
    return 'text';
  }
  return 'bool';
}

function currencyCode(pattern) {
  if (!pattern) return null;
  if (pattern.includes('€')) return 'EUR';
  if (pattern.includes('£')) return 'GBP';
  if (pattern.includes('¥')) return 'JPY';
  if (pattern.includes('₹')) return 'INR';
  if (pattern.includes('$')) return 'USD';
  return null;
}

// Builds a structural model of a sheet's main table.
export function buildModel(grid) {
  const { cells, sheetTitle, sheetId, startRow, startCol } = grid;
  const q = quoteSheet(sheetTitle);
  const ambiguities = [];
  const model = { sheetTitle, sheetId, headerRow: null, dataStartRow: null, dataEndRow: null, columns: [], ambiguities, gaps: [], notes: [] };
  if (!cells.length) {
    ambiguities.push({ kind: 'empty_sheet', message: `Sheet "${sheetTitle}" has no data.` });
    return model;
  }
  // Header = first row that is mostly text and is followed by a row containing numbers.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(cells.length - 1, 20); i++) {
    const kinds = cells[i].map(cellKind).filter(k => k !== 'empty');
    const next = cells[i + 1].map(cellKind);
    if (kinds.length >= 2 && kinds.filter(k => k === 'text' || k === 'period_text').length / kinds.length >= 0.75 &&
        next.some(k => ['number', 'currency', 'percent', 'date'].includes(k))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    ambiguities.push({ kind: 'no_header', message: 'Could not identify a header row. Ask the user which range holds the table (e.g. "Sheet1!A1:E13").' });
    return model;
  }
  // Data rows: contiguous non-empty rows after the header.
  let end = headerIdx + 1;
  while (end < cells.length && cells[end].some(c => cellKind(c) !== 'empty')) end++;
  if (cells.slice(end).some(r => r.some(c => cellKind(c) !== 'empty'))) {
    ambiguities.push({ kind: 'multiple_blocks', message: `Additional data found below row ${startRow + end + 1} after a blank row; only rows ${startRow + headerIdx + 2}-${startRow + end} are treated as the main table. Ask the user if another range is intended.` });
  }
  model.headerRow = startRow + headerIdx + 1; // 1-based
  model.dataStartRow = model.headerRow + 1;
  model.dataEndRow = startRow + end; // 1-based inclusive
  const dataRows = cells.slice(headerIdx + 1, end);
  const seen = new Map();
  cells[headerIdx].forEach((h, ci) => {
    const colLetter = indexToCol(startCol + ci);
    const name = (h.t ?? '').trim();
    const colCells = dataRows.map(r => r[ci]);
    const kinds = colCells.map(cellKind);
    const nonEmpty = kinds.filter(k => k !== 'empty');
    if (!name && !nonEmpty.length) return;
    const counts = {};
    for (const k of nonEmpty) counts[k] = (counts[k] ?? 0) + 1;
    let type = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'empty';
    if (type === 'period_text') type = 'period';
    const purity = nonEmpty.length ? (counts[Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]] / nonEmpty.length) : 1;
    const col = {
      name: name || null,
      letter: colLetter,
      index: startCol + ci,
      type,
      range: `${q}!${colLetter}${model.dataStartRow}:${colLetter}${model.dataEndRow}`,
      header_cell: `${q}!${colLetter}${model.headerRow}`,
      currency: type === 'currency' ? currencyCode(colCells.find(c => c.fmt)?.fmt?.pattern) : null,
      has_formulas: colCells.some(c => c.f),
      formula_example: colCells.find(c => c.f)?.f ?? null,
      missing_cells: [],
      error_cells: [],
    };
    colCells.forEach((c, ri) => {
      const addr = `${q}!${colLetter}${model.dataStartRow + ri}`;
      if (kinds[ri] === 'empty') col.missing_cells.push(addr);
      if (kinds[ri] === 'error') col.error_cells.push(`${addr} (${c.err})`);
    });
    if (!name) ambiguities.push({ kind: 'unnamed_column', message: `Column ${colLetter} has data but no header. Ask the user what it represents.` });
    if (name && seen.has(name.toLowerCase())) ambiguities.push({ kind: 'duplicate_header', message: `Header "${name}" appears in columns ${seen.get(name.toLowerCase())} and ${colLetter}. Refer to columns by letter.` });
    if (name) seen.set(name.toLowerCase(), colLetter);
    if (purity < 0.8 && nonEmpty.length) ambiguities.push({ kind: 'mixed_types', message: `Column ${colLetter} ("${name}") mixes ${Object.keys(counts).join(', ')} values.` });
    if (col.missing_cells.length && ['number', 'currency', 'percent'].includes(type)) model.gaps.push(...col.missing_cells);
    model.columns.push(col);
  });
  const dateCol = model.columns.find(c => c.type === 'date' || c.type === 'period');
  model.period_column = dateCol?.letter ?? null;
  if (dateCol?.type === 'date') {
    const serials = dataRows.map(r => r[dateCol.index - startCol]?.v).filter(v => typeof v === 'number');
    if (serials.length) {
      model.period_range = { first: serialToISO(serials[0]), last: serialToISO(serials.at(-1)) };
      model.period_granularity = detectGranularity(serials);
    }
  }
  if (!dateCol) model.notes.push('No date/period column detected; forecasts will treat rows as sequential periods.');
  return model;
}

function detectGranularity(serials) {
  if (serials.length < 2) return 'unknown';
  const diffs = serials.slice(1).map((s, i) => s - serials[i]);
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  if (avg >= 27 && avg <= 32) return 'monthly';
  if (avg >= 88 && avg <= 93) return 'quarterly';
  if (avg >= 6 && avg <= 8) return 'weekly';
  if (avg >= 364 && avg <= 367) return 'yearly';
  return 'irregular';
}

export function resolveColumn(model, ref) {
  if (!ref) throw new Error('Column reference required');
  const s = String(ref).trim();
  const byName = model.columns.filter(c => c.name && c.name.toLowerCase() === s.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`Column name "${s}" is ambiguous (${byName.map(c => c.letter).join(', ')}); use the column letter.`);
  if (/^[A-Z]{1,3}$/i.test(s)) {
    const col = model.columns.find(c => c.letter === s.toUpperCase());
    if (col) return col;
  }
  throw new Error(`Column "${s}" not found. Available: ${model.columns.map(c => `${c.letter}=${c.name ?? '(unnamed)'}`).join(', ')}`);
}

export function columnValues(grid, model, col) {
  const out = [];
  for (let r = model.dataStartRow; r <= model.dataEndRow; r++) {
    const c = grid.cells[r - 1 - grid.startRow]?.[col.index - grid.startCol];
    out.push({ row: r, cell: `${quoteSheet(model.sheetTitle)}!${col.letter}${r}`, value: typeof c?.v === 'number' ? c.v : null });
  }
  return out;
}

const round = (x, d = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function columnStats(grid, model, col) {
  const vals = columnValues(grid, model, col);
  const nums = vals.filter(v => v.value !== null);
  const sum = nums.reduce((a, b) => a + b.value, 0);
  const growth = [];
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1].value, b = vals[i].value;
    growth.push({ period_row: vals[i].row, growth_pct: a ? round(((b - a) / Math.abs(a)) * 100) : null, cells: [vals[i - 1].cell, vals[i].cell] });
  }
  const validGrowth = growth.filter(g => g.growth_pct !== null);
  const first = nums[0], last = nums.at(-1);
  const n = nums.length - 1;
  return {
    column: col.name, letter: col.letter, source_range: col.range, count: nums.length,
    missing: vals.filter(v => v.value === null).map(v => v.cell),
    total: round(sum), average: nums.length ? round(sum / nums.length) : null,
    min: nums.length ? round(Math.min(...nums.map(v => v.value))) : null,
    max: nums.length ? round(Math.max(...nums.map(v => v.value))) : null,
    first: first ? { value: first.value, cell: first.cell } : null,
    last: last ? { value: last.value, cell: last.cell } : null,
    period_over_period_growth: growth,
    average_growth_pct: validGrowth.length ? round(validGrowth.reduce((a, g) => a + g.growth_pct, 0) / validGrowth.length) : null,
    compound_growth_pct_per_period: first && last && n > 0 && first.value > 0 && last.value > 0 ? round((Math.pow(last.value / first.value, 1 / n) - 1) * 100) : null,
    sheets_formula_equivalents: { total: `=SUM(${col.range})`, average: `=AVERAGE(${col.range})` },
  };
}

export function profitAndMargin(grid, model, revenueCol, costCols) {
  const rev = columnValues(grid, model, revenueCol);
  const costs = costCols.map(c => columnValues(grid, model, c));
  const rows = rev.map((r, i) => {
    const parts = costs.map(c => c[i].value);
    if (r.value === null || parts.some(p => p === null)) return { row: r.row, profit: null, margin_pct: null, note: 'missing input value(s); not computed' };
    const cost = parts.reduce((a, b) => a + b, 0);
    return { row: r.row, revenue: r.value, total_cost: round(cost), profit: round(r.value - cost), margin_pct: r.value ? round(((r.value - cost) / r.value) * 100) : null };
  });
  const complete = rows.filter(r => r.profit !== null);
  const totRev = complete.reduce((a, r) => a + r.revenue, 0);
  const totProfit = complete.reduce((a, r) => a + r.profit, 0);
  return {
    definition: `profit = ${revenueCol.name} - (${costCols.map(c => c.name).join(' + ')}); margin = profit / ${revenueCol.name}`,
    source_ranges: [revenueCol.range, ...costCols.map(c => c.range)],
    rows,
    totals: { revenue: round(totRev), profit: round(totProfit), margin_pct: totRev ? round((totProfit / totRev) * 100) : null, rows_included: complete.length, rows_excluded: rows.length - complete.length },
    sheets_formula_template: `=${revenueCol.letter}{row}-(${costCols.map(c => `${c.letter}{row}`).join('+')})`,
  };
}

// --- Forecasting -----------------------------------------------------------

export const FORECAST_METHODS = ['moving_average', 'linear_trend', 'average_growth'];

export function forecastSeries(values, { method = 'moving_average', periods = 3, window = 3 } = {}) {
  const warnings = [];
  const minPoints = method === 'moving_average' ? window : method === 'linear_trend' ? 3 : 2;
  if (values.length < minPoints) {
    return { ok: false, reason: `Insufficient data: ${method} needs at least ${minPoints} actual values, found ${values.length}. No forecast produced.` };
  }
  if (values.length < 6) warnings.push(`Only ${values.length} actual periods available; treat projections as low confidence.`);
  const out = [];
  const series = [...values];
  if (method === 'moving_average') {
    for (let i = 0; i < periods; i++) {
      const w = series.slice(-window);
      const next = w.reduce((a, b) => a + b, 0) / window;
      series.push(next);
      out.push(next);
    }
  } else if (method === 'linear_trend') {
    const n = values.length;
    const xs = values.map((_, i) => i + 1);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = values.reduce((a, b) => a + b, 0) / n;
    const slope = xs.reduce((a, x, i) => a + (x - mx) * (values[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const intercept = my - slope * mx;
    for (let i = 1; i <= periods; i++) out.push(intercept + slope * (n + i));
    const ssTot = values.reduce((a, y) => a + (y - my) ** 2, 0);
    const ssRes = values.reduce((a, y, i) => a + (y - (intercept + slope * (i + 1))) ** 2, 0);
    const r2 = ssTot ? 1 - ssRes / ssTot : 1;
    if (r2 < 0.5) warnings.push(`Linear fit is weak (R² = ${round(r2, 3)}).`);
    return { ok: true, projections: out.map(v => round(v)), params: { slope: round(slope, 4), intercept: round(intercept, 4), r_squared: round(r2, 4) }, warnings };
  } else if (method === 'average_growth') {
    const g = [];
    for (let i = 1; i < values.length; i++) if (values[i - 1]) g.push(values[i] / values[i - 1] - 1);
    const avg = g.reduce((a, b) => a + b, 0) / g.length;
    let last = values.at(-1);
    for (let i = 0; i < periods; i++) { last = last * (1 + avg); out.push(last); }
    return { ok: true, projections: out.map(v => round(v)), params: { average_growth_pct: round(avg * 100, 4) }, warnings };
  } else {
    return { ok: false, reason: `Unknown method ${method}. Supported: ${FORECAST_METHODS.join(', ')}` };
  }
  return { ok: true, projections: out.map(v => round(v)), params: { window }, warnings };
}

export function nextPeriodSerials(lastSerial, granularity, periods) {
  const d = new Date(SERIAL_EPOCH + lastSerial * 86400000);
  const step = { monthly: 1, quarterly: 3, yearly: 12 }[granularity];
  const out = [];
  for (let i = 1; i <= periods; i++) {
    if (step) {
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step * i, d.getUTCDate()));
      out.push((n - SERIAL_EPOCH) / 86400000);
    } else if (granularity === 'weekly') out.push(lastSerial + 7 * i);
    else out.push(null);
  }
  return out;
}

// Sheets formula that reproduces projection i (0-based) for a column, given row layout.
export function forecastFormula(method, { letter, firstDataRow, lastActualRow, targetRow, window, params }) {
  if (method === 'moving_average') return `=AVERAGE(${letter}${targetRow - window}:${letter}${targetRow - 1})`;
  if (method === 'linear_trend') {
    const n = lastActualRow - firstDataRow + 1;
    return `=ROUND(FORECAST(${targetRow - firstDataRow + 1},$${letter}$${firstDataRow}:$${letter}$${lastActualRow},SEQUENCE(${n})),2)`;
  }
  if (method === 'average_growth') return `=ROUND(${letter}${targetRow - 1}*(1+${params.average_growth_pct}/100),2)`;
  return null;
}

// --- Tiny formula evaluator for previews (deterministic expected values) ---

export function makeEvaluator(lookup) {
  // lookup(colIndex, row1Based) -> number|null
  const FN = {
    SUM: a => a.flat().filter(Number.isFinite).reduce((x, y) => x + y, 0),
    AVERAGE: a => { const v = a.flat().filter(Number.isFinite); if (!v.length) throw new Error('#DIV/0!'); return v.reduce((x, y) => x + y, 0) / v.length; },
    MIN: a => Math.min(...a.flat().filter(Number.isFinite)),
    MAX: a => Math.max(...a.flat().filter(Number.isFinite)),
    COUNT: a => a.flat().filter(Number.isFinite).length,
    ABS: a => Math.abs(a[0]),
    ROUND: a => { const p = 10 ** (a[1] ?? 0); return Math.round(a[0] * p) / p; },
  };
  return function evaluate(formula) {
    const src = formula.replace(/^=/, '');
    let i = 0;
    const peek = () => src.slice(i).match(/^\s*/)[0].length + i;
    const ws = () => { i = peek(); };
    const expect = ch => { ws(); if (src[i] !== ch) throw new Error(`unsupported near "${src.slice(i, i + 8)}"`); i++; };
    const atom = () => {
      ws();
      if (src[i] === '(') { i++; const v = expr(); expect(')'); return v; }
      if (src[i] === '-') { i++; return -atom(); }
      if (src[i] === '+') { i++; return atom(); }
      let m = src.slice(i).match(/^\d+(\.\d+)?/);
      if (m) { i += m[0].length; return Number(m[0]); }
      m = src.slice(i).match(/^([A-Z]+)\(/i);
      if (m) {
        const fn = FN[m[1].toUpperCase()];
        if (!fn) throw new Error(`function ${m[1]} not previewable`);
        i += m[0].length;
        const args = [];
        ws();
        if (src[i] !== ')') {
          for (;;) { args.push(arg()); ws(); if (src[i] === ',') { i++; continue; } break; }
        }
        expect(')');
        return fn(args);
      }
      m = src.slice(i).match(/^\$?([A-Z]{1,3})\$?(\d+)/i);
      if (m) {
        i += m[0].length;
        const v = lookup(colToIndex(m[1]), Number(m[2]));
        if (v === null || v === undefined) return 0;
        if (!Number.isFinite(v)) throw new Error('non-numeric reference');
        return v;
      }
      throw new Error(`unsupported near "${src.slice(i, i + 8)}"`);
    };
    const arg = () => {
      ws();
      const m = src.slice(i).match(/^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)/i);
      if (m) {
        i += m[0].length;
        const out = [];
        for (let r = Number(m[2]); r <= Number(m[4]); r++)
          for (let c = colToIndex(m[1]); c <= colToIndex(m[3]); c++) { const v = lookup(c, r); if (Number.isFinite(v)) out.push(v); }
        return out;
      }
      return expr();
    };
    const power = () => { let v = atom(); ws(); while (src[i] === '^') { i++; v = v ** atom(); ws(); } return v; };
    const term = () => {
      let v = power(); ws();
      while (src[i] === '*' || src[i] === '/') {
        const op = src[i++]; const r = power();
        if (op === '/' && r === 0) throw new Error('#DIV/0!');
        v = op === '*' ? v * r : v / r; ws();
      }
      return v;
    };
    function expr() {
      let v = term(); ws();
      while (src[i] === '+' || src[i] === '-') { const op = src[i++]; const r = term(); v = op === '+' ? v + r : v - r; ws(); }
      return v;
    }
    const v = expr();
    ws();
    if (i < src.length) throw new Error(`unsupported near "${src.slice(i, i + 8)}"`);
    return v;
  };
}
