// Records a basic feature demo: screen capture (ffmpeg x11grab) of Chrome with the side panel open,
// while a scripted WebMCP client plays the agent and the panel's own buttons are clicked as the user.
// Precondition: sheet tab 1 holds only the demo data; side panel open (scripts/open-panel.mjs).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { connect } from './lib.mjs';

const OUT = path.resolve(process.argv[2] ?? 'demo/byoa-sheets-demo.mp4');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const b = await connect();
const sheet = (await b.pages()).find(p => p.url().includes('/spreadsheets/d/'));
const panelTarget = (await b.targets()).find(t => t.url().includes('panel/panel.html'));
if (!sheet || !panelTarget) throw new Error('Need the spreadsheet tab and the open side panel');
const panel = await panelTarget.page();
await sheet.bringToFront();

// --- helpers ---------------------------------------------------------------------
async function caption(text, sub = '') {
  await sheet.evaluate((text, sub) => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      Object.assign(el.style, { position: 'fixed', left: '24px', bottom: '64px', maxWidth: '900px', zIndex: 2147483646, background: 'rgba(23,32,27,.92)', color: '#fff', font: '500 20px/1.35 system-ui, sans-serif', padding: '14px 18px', borderRadius: '10px', boxShadow: '0 4px 18px rgba(0,0,0,.3)', pointerEvents: 'none' });
      document.documentElement.append(el);
    }
    el.replaceChildren();
    const t = document.createElement('div'); t.textContent = text; el.append(t);
    if (sub) { const s = document.createElement('div'); s.textContent = sub; Object.assign(s.style, { font: '400 15px/1.4 ui-monospace, monospace', color: '#b9e3cf', marginTop: '6px' }); el.append(s); }
  }, text, sub);
}

async function agent(tool, args = {}) {
  const out = await sheet.evaluate(async (tool, args) => {
    const t = (await document.modelContext.getTools()).find(t => t.name === tool);
    const res = JSON.parse(await document.modelContext.executeTool(t, args));
    return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
  }, tool, args);
  if (out.isError) throw new Error(`${tool}: ${JSON.stringify(out.data)}`);
  return out.data;
}

// Highlight a panel element, then click it with a trusted CDP click.
async function panelClick(selectorOrText) {
  const handle = await panel.evaluateHandle(sel => {
    const byText = [...document.querySelectorAll('button, summary')].find(e => e.textContent.trim().startsWith(sel));
    return byText ?? document.querySelector(sel);
  }, selectorOrText);
  const el = handle.asElement();
  if (!el) throw new Error(`panel element not found: ${selectorOrText}`);
  await el.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.style.outline = '3px solid #f2b705'; e.style.outlineOffset = '2px'; });
  await sleep(900);
  await el.click();
  await el.evaluate(e => { e.style.outline = ''; }).catch(() => {});
}
const panelTab = name => panelClick(`button[data-tab="${name}"]`);
const panelScroll = sel => panel.evaluate(s => document.querySelector(s)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), sel);
const panelTop = () => panel.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
async function waitPlan(id, done = s => !['pending_approval', 'executing'].includes(s)) {
  for (let i = 0; i < 120; i++) { const s = await agent('get_plan_status', { plan_id: id }); if (done(s.status)) return s; await sleep(1000); }
  throw new Error('plan did not finish');
}

// --- record ------------------------------------------------------------------------
const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '24', '-video_size', '1920x1080', '-i', process.env.DEMO_DISPLAY ?? ':99.0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
await sleep(1500);

try {
  await panelTab('agent');
  await caption('Bring Your Own Agent to Sheets', 'Your own browser agent works in this Google Sheet through WebMCP tools. The "agent" in this demo is a scripted WebMCP client.');
  await sleep(5000);

  await caption('1. The agent connects and discovers the tools', 'agent → get_workspace_info({ agent_name: "Demo agent" })');
  await agent('get_workspace_info', { agent_name: 'Demo agent (scripted)' });
  await sleep(4000);

  await caption('2. The agent reads the sheet: headers, dates, currency, gaps', 'agent → describe_sheet()');
  await agent('describe_sheet');
  await panelTab('context');
  await sleep(1500);
  await panelScroll('table.cells');
  await sleep(3500);

  await caption('The user can add company context: goals, assumptions, documents', 'panel → upload demo/company-goals.md');
  await panelTop();
  const file = await panel.$('#docFile');
  await file.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.style.outline = '3px solid #f2b705'; });
  await sleep(900);
  await file.uploadFile(path.resolve('demo/company-goals.md'));
  await sleep(3500);

  await caption('3. Agent proposes a Profit column — nothing is written yet', 'agent → propose_changes([set_values F1, write_formula F2:F10 "=B{row}-C{row}-D{row}-E{row}", …])');
  const profit = await agent('propose_changes', { title: 'Add Profit column', rationale: 'User asked for profit by month (revenue minus COGS, marketing and opex).', assumptions: ['Profit = Revenue - COGS - Marketing - Opex'], operations: [
    { op: 'set_values', range: 'F1', values: [['Profit']] },
    { op: 'write_formula', range: 'F2:F10', formula: '=B{row}-C{row}-D{row}-E{row}' },
    { op: 'format_range', range: 'F1', bold: true },
    { op: 'format_range', range: 'F2:F10', number_format: 'currency', decimals: 0 },
  ] });
  await panelTab('review');
  await sleep(4500);
  await caption('The user reviews the before/after preview and approves', 'Expected values are computed independently, then verified after the write');
  await panelClick('Approve & apply');
  await waitPlan(profit.plan_id);
  await sleep(3500);

  await caption('4. Agent forecasts Q4 (3-month moving average) and proposes rows + a chart', 'agent → forecast({ columns: [Revenue, COGS, Marketing, Opex] }) → propose_changes([append_forecast_rows, add_chart])');
  const fc = await agent('forecast', { columns: ['Revenue', 'COGS', 'Marketing', 'Opex'], method: 'moving_average', periods: 3 });
  const fcPlan = await agent('propose_changes', { title: 'Q4 forecast + revenue chart', rationale: 'Q4 projection from actuals, marked as Forecast.', assumptions: fc.assumptions, operations: [
    { op: 'append_forecast_rows', forecast_id: fc.forecast_id },
    { op: 'add_chart', chart_type: 'line', title: 'Revenue: actual + forecast', domain_range: 'A1:A13', series_ranges: ['B1:B13'], anchor_cell: 'I2' },
  ] });
  await sleep(1500);
  await panelScroll('svg.chart');
  await sleep(4500);
  await caption('Approve: the extension edits the sheet through the page, like a user would', 'forecast values are written as formulas (=AVERAGE(...)) and marked "Forecast"');
  await panelClick('Approve & apply');
  await waitPlan(fcPlan.plan_id);
  await sleep(4000);

  await caption('5. What-if: cut marketing 10% — hypothetical, the sheet is not changed', 'agent → run_scenario({ adjustments: [{ column: "Marketing", change_pct: -10 }], forecast_id })');
  await agent('run_scenario', { name: 'Marketing -10%', revenue_column: 'Revenue', cost_columns: ['COGS', 'Marketing', 'Opex'], adjustments: [{ column: 'Marketing', change_pct: -10 }], forecast_id: fc.forecast_id, notes: 'Assumes no revenue impact.' });
  await caption('The agent posts findings (cited to cells) and suggestions (cited to its own memory)', 'agent → post_insights(...)');
  await agent('post_insights', { title: 'Q4 outlook', findings: [
    { statement: 'Revenue grew every month Jan–Sep 2026 (avg 3.84% MoM).', evidence: [{ type: 'sheet_range', ref: 'Sheet1!B2:B10' }] },
    { statement: 'Projected Q4 revenue is $1.62M (3-month moving average).', evidence: [{ type: 'metric', ref: fc.forecast_id }, { type: 'sheet_range', ref: 'Sheet1!B11:B13' }] },
  ], suggestions: [
    { statement: 'Q4 is tracking below the $1.8M target; a 10% marketing cut would add ~$32K profit but may slow growth.', rationale: 'Target from company goals; scenario assumes no revenue impact.', confidence: 'medium', sources: [{ type: 'agent_memory', ref: 'FY26 goals: Q4 revenue target $1.8M' }, { type: 'metric', ref: fc.forecast_id }] },
  ] });
  await panelTab('analysis');
  await sleep(5500);
  await panelScroll('.card.hyp');
  await sleep(4500);

  await caption('6. Sync: the user picks what to keep and approves a summary', 'facts, projections and suggestions are labeled; hypotheticals excluded by default');
  await panelTab('sync');
  await sleep(3500);
  await panelClick('Approve summary for my agent');
  await sleep(2000);
  await caption('The agent fetches it and saves it to its own memory', 'agent → get_approved_summary() → confirm_summary_saved({ destination: "agent memory" })');
  const sum = await agent('get_approved_summary');
  await sleep(1500);
  await agent('confirm_summary_saved', { summary_id: sum.summary_id, destination: 'Demo agent memory', reference: 'mem://fy26/q4-forecast' });
  await panelScroll('.timeline');
  await sleep(5000);

  await caption('7. Everything is audited: tool calls, approvals, executions, sync', 'History tab');
  await panelTab('history');
  await sleep(5000);

  await caption('Bring Your Own Agent to Sheets', 'Your agent brings the context · you approve every write · approved results sync back');
  await panelTab('agent');
  await sleep(4000);
} finally {
  await sheet.evaluate(() => document.getElementById('__demo_caption')?.remove()).catch(() => {});
  ff.stdin.write('q');
  await new Promise(r => ff.on('close', r));
  await b.disconnect();
  console.log('saved', OUT);
}
