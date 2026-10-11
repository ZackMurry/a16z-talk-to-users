import test from 'node:test';
import assert from 'node:assert/strict';
import { parseA1, toA1, colToIndex, indexToCol, shiftFormulaRows } from '../extension/src/a1.js';
import { forecastSeries, makeEvaluator, buildModel, normalizeCell, nextPeriodSerials, serialToISO, isoToSerial } from '../extension/src/analysis.js';
import { validateFormula, compileOperation, computeExpected } from '../extension/src/ops.js';

test('a1', () => {
  assert.deepEqual(parseA1("'P&L'!B2:C10"), { sheet: 'P&L', startRow: 1, endRow: 10, startCol: 1, endCol: 3 });
  assert.equal(toA1({ sheet: 'P&L', startRow: 1, endRow: 10, startCol: 1, endCol: 3 }), "'P&L'!B2:C10");
  assert.equal(toA1({ sheet: 'S', startRow: 0, endRow: 1, startCol: 0, endCol: 1 }), 'S!A1');
  assert.equal(indexToCol(colToIndex('AB')), 'AB');
  assert.equal(parseA1('F:F').endRow, null);
  assert.throws(() => parseA1('B5:B2'));
  assert.equal(shiftFormulaRows('=B10-SUM(C10:E10)+$A$1+LOG10(B10)', 2), '=B12-SUM(C12:E12)+$A$1+LOG10(B12)');
});

test('forecast methods', () => {
  const ma = forecastSeries([1, 2, 3, 4, 5, 6], { method: 'moving_average', periods: 3, window: 3 });
  assert.deepEqual(ma.projections, [5, 5.33, 5.44]);
  const lt = forecastSeries([10, 20, 30], { method: 'linear_trend', periods: 2 });
  assert.deepEqual(lt.projections, [40, 50]);
  assert.equal(forecastSeries([1, 2], { method: 'moving_average', window: 3 }).ok, false);
  const ag = forecastSeries([100, 110, 121], { method: 'average_growth', periods: 1 });
  assert.equal(ag.projections[0], 133.1);
});

test('dates', () => {
  assert.equal(serialToISO(isoToSerial('2026-09-01')), '2026-09-01');
  assert.deepEqual(nextPeriodSerials(isoToSerial('2026-09-01'), 'monthly', 3).map(serialToISO), ['2026-10-01', '2026-11-01', '2026-12-01']);
});

test('evaluator', () => {
  const vals = { '1,2': 10, '2,2': 4, '1,3': 20, '1,4': 30 };
  const ev = makeEvaluator((c, r) => vals[`${c},${r}`] ?? null);
  assert.equal(ev('=B2-C2'), 6);
  assert.equal(ev('=AVERAGE(B2:B4)'), 20);
  assert.equal(ev('=ROUND((B2-C2)/B2*100,1)'), 60);
  assert.throws(() => ev('=VLOOKUP(1,A:B,2)'));
  assert.throws(() => ev('=B2/0'));
});

test('formula validation', () => {
  const sheets = new Set(['P&L']);
  assert.deepEqual(validateFormula('=B2-C2', sheets), []);
  assert.ok(validateFormula('=IMPORTXML("http://x","//a")', sheets).length);
  assert.ok(validateFormula('=SUM(B2:B3', sheets).length);
  assert.ok(validateFormula("='Other'!A1", sheets).length);
  assert.deepEqual(validateFormula("='P&L'!A1*2", sheets), []);
  assert.ok(validateFormula('=FOO(1)', sheets).length);
});

function fakeGrid() {
  const cur = { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' } };
  const cell = (v, fmt) => ({ effectiveValue: typeof v === 'number' ? { numberValue: v } : { stringValue: v }, formattedValue: String(v), effectiveFormat: fmt ?? {} });
  const rows = [['Month', 'Revenue', 'COGS'].map(t => cell(t))];
  const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'];
  months.forEach((m, i) => rows.push([cell(isoToSerial(m), { numberFormat: { type: 'DATE', pattern: 'mmm yyyy' } }), cell(100 + i * 10, cur), cell(40 + i, cur)]));
  return { sheetTitle: 'P&L', sheetId: 0, startRow: 0, startCol: 0, cells: rows.map(r => r.map(normalizeCell)), hash: 'h' };
}

test('model detection', () => {
  const m = buildModel(fakeGrid());
  assert.equal(m.headerRow, 1);
  assert.equal(m.dataEndRow, 5);
  assert.deepEqual(m.columns.map(c => [c.name, c.type, c.currency]), [['Month', 'date', null], ['Revenue', 'currency', 'USD'], ['COGS', 'currency', 'USD']]);
  assert.equal(m.period_granularity, 'monthly');
  assert.equal(m.columns[1].range, "'P&L'!B2:B5");
});

test('compile write_formula + expected + overwrite guard', () => {
  const g = fakeGrid();
  const ctx = { spreadsheetId: 'x', activeSheetTitle: 'P&L', grids: new Map([['P&L', g]]), forecasts: {} };
  const ps = () => ({ knownSheets: new Set(['P&L']), newSheets: new Set(), written: new Set(), cellMap: new Map(), protectedRanges: [], sheetIdFor: () => 0 });
  let st = ps();
  const ops = [compileOperation(ctx, { op: 'set_values', range: 'D1', values: [['Profit']] }, 0, st), compileOperation(ctx, { op: 'write_formula', range: 'D2:D5', formula: '=B{row}-C{row}' }, 1, st)];
  computeExpected(ctx, st, ops);
  assert.deepEqual(ops[1].errors, []);
  assert.deepEqual(ops[1].writes.map(w => w.expected), [60, 69, 78, 87]);
  st = ps();
  const bad = compileOperation(ctx, { op: 'set_values', range: 'B2', values: [[1]] }, 0, st);
  assert.match(bad.errors[0], /overwrite/);
  st = ps();
  const prot = compileOperation(ctx, { op: 'set_values', range: 'D2', values: [[1]] }, 0, { ...st, protectedRanges: [{ sheet: 'P&L', startRow: 0, endRow: 10, startCol: 3, endCol: 4 }] });
  assert.match(prot.errors[0], /protected/);
});

test('append_forecast_rows compiles reproducible formulas', () => {
  const g = fakeGrid();
  const fc = { id: 'fc1', spreadsheetId: 'x', sheet: 'P&L', method: 'moving_average', periods: 2, window: 3, series: [{ letter: 'B', projections: [120, 123.33], params: {} }], periodLabels: ['2026-05-01', '2026-06-01'], periodColumn: 'A', firstDataRow: 2, lastActualRow: 5, headerRow: 1, formulaColumns: [], typeColumn: null, nextEmptyCol: 3, sourceHash: 'h', assumptions: [] };
  const ctx = { spreadsheetId: 'x', activeSheetTitle: 'P&L', grids: new Map([['P&L', g]]), forecasts: { fc1: fc } };
  const st = { knownSheets: new Set(['P&L']), newSheets: new Set(), written: new Set(), cellMap: new Map(), protectedRanges: [], sheetIdFor: () => 0 };
  const op = compileOperation(ctx, { op: 'append_forecast_rows', forecast_id: 'fc1' }, 0, st);
  computeExpected(ctx, st, [op]);
  assert.deepEqual(op.errors, []);
  const b = op.writes.filter(w => w.a1.includes('!B'));
  assert.deepEqual(b.map(w => w.content), ['=AVERAGE(B3:B5)', '=AVERAGE(B4:B6)']);
  assert.deepEqual(b.map(w => w.expected), [120, 123.33]);
  assert.ok(op.writes.some(w => w.content === 'Type'));
  assert.equal(op.writes.filter(w => w.content === 'Forecast').length, 2);
});
