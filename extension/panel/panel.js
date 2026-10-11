// Side panel: the user's control surface. Renders from chrome.storage.local and sends actions
// to the service worker. Nothing here writes to Sheets without an explicit user click.

const $ = s => document.querySelector(s);
const main = $('#main');

const state = {
  tab: 'agent',
  activeTab: null, // browser tab
  spreadsheetId: null,
  url: null,
  data: {},
  auth: null,
  sheetInfo: null,
  sheetInfoError: null,
  ui: { opSel: {}, feedback: {}, syncSel: null, historyFilter: 'all', busy: new Set() },
};

// --- helpers -----------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function act(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ channel: 'panel', type, ...payload });
  if (!res?.ok) {
    const err = new Error(res?.error ?? 'Unknown error');
    err.actionable = res?.actionable;
    throw err;
  }
  return res.result;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 6000 : 3000);
}

async function withBusy(key, fn) {
  if (state.ui.busy.has(key)) return;
  state.ui.busy.add(key);
  render();
  try { return await fn(); } catch (e) { toast(`${e.message}${e.actionable ? ` — ${e.actionable}` : ''}`, true); } finally { state.ui.busy.delete(key); render(); }
}

const fmtTime = ts => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtNum = v => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v === null || v === undefined ? '—' : String(v));
const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : fmtTime(ts); };
const forSheet = coll => Object.values(state.data[coll] ?? {}).filter(x => x.spreadsheetId === state.spreadsheetId).sort((a, b) => b.createdAt - a.createdAt);

const STATUS = {
  pending_approval: ['Awaiting approval', 'b-warn'], invalid: ['Invalid', 'b-bad'], stale: ['Stale — re-propose', 'b-bad'],
  rejected: ['Rejected', 'b-neutral'], revision_requested: ['Revision requested', 'b-info'], executing: ['Executing', 'b-info'],
  executed: ['Executed ✓ verified', 'b-ok'], executed_with_issues: ['Executed — check issues', 'b-warn'], partial_failure: ['Partial failure', 'b-bad'],
  failed: ['Failed', 'b-bad'], reverted: ['Reverted', 'b-neutral'], superseded: ['Superseded', 'b-neutral'],
};
const badge = (text, cls) => h('span', { class: `badge ${cls}` }, text);

function rangeLink(ref, gid) {
  return h('button', { class: 'btn link mono', title: 'Show in sheet', onclick: () => gotoRange(ref, gid) }, ref);
}
function gotoRange(ref, gid) {
  if (!state.activeTab || !state.spreadsheetId) return;
  const body = ref.includes('!') ? ref.slice(ref.lastIndexOf('!') + 1) : ref;
  let g = gid;
  if (g === undefined && ref.includes('!')) {
    const title = ref.slice(0, ref.lastIndexOf('!')).replace(/^'|'$/g, '').replace(/''/g, "'");
    g = state.sheetInfo?.tabsMeta?.[title];
  }
  const url = `https://docs.google.com/spreadsheets/d/${state.spreadsheetId}/edit#${g !== undefined ? `gid=${g}&` : ''}range=${body}`;
  chrome.tabs.update(state.activeTab.id, { url });
}

// --- data loading --------------------------------------------------------------

async function loadAll() {
  state.data = await chrome.storage.local.get(null);
}

async function refreshActiveTab() {
  // ?tabId= pins the panel to a tab (used when the panel is opened as a page for testing).
  const pinned = Number(new URLSearchParams(location.search).get('tabId'));
  const [tab] = pinned ? [await chrome.tabs.get(pinned).catch(() => null)] : await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTab = tab ?? null;
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(tab?.url ?? '')?.[1] ?? null;
  const changed = id !== state.spreadsheetId;
  state.spreadsheetId = id;
  state.url = tab?.url ?? null;
  if (changed) { state.sheetInfo = null; state.sheetInfoError = null; state.ui.syncSel = null; loadSheetInfo(); }
  render();
}

async function loadSheetInfo() {
  if (!state.spreadsheetId) return;
  try {
    state.sheetInfo = await act('sheet:info', { spreadsheetId: state.spreadsheetId, url: state.url, tabId: state.activeTab?.id });
    state.sheetInfoError = null;
  } catch (e) {
    state.sheetInfo = null;
    state.sheetInfoError = e;
  }
  render();
}

// --- header --------------------------------------------------------------------

function renderHeader() {
  $('#sheetTitle').textContent = state.sheetInfo?.title ?? (state.spreadsheetId ? 'Google Sheet' : 'Open a Google Sheet to begin');
  const tabStatus = state.data.tabs?.[state.activeTab?.id];
  const agent = state.data.agent ?? {};
  const pills = [];
  if (!state.spreadsheetId) pills.push(h('span', { class: 'pill' }, 'No sheet in this tab'));
  else if (agent.enabled === false) pills.push(h('span', { class: 'pill bad' }, 'Agent disconnected'));
  else if (tabStatus?.webmcp === 'unavailable') pills.push(h('span', { class: 'pill bad' }, 'WebMCP unavailable'));
  else if (tabStatus?.registered) pills.push(h('span', { class: 'pill ok' }, `Agent connected · ${tabStatus.registered} tools`));
  else pills.push(h('span', { class: 'pill warn' }, 'Waiting for page'));
  if (state.sheetInfo?.perm?.can_edit === false) pills.push(h('span', { class: 'pill bad' }, 'View only'));
  $('#pills').replaceChildren(...pills);
  const pending = forSheet('plans').filter(p => p.status === 'pending_approval').length;
  const rc = $('#reviewCount');
  rc.hidden = !pending;
  rc.textContent = pending;
  rc.setAttribute('aria-label', `${pending} pending`);
  for (const b of document.querySelectorAll('.tabs button')) {
    const sel = b.dataset.tab === state.tab;
    b.setAttribute('aria-selected', sel);
    b.tabIndex = sel ? 0 : -1;
  }
  main.setAttribute('aria-labelledby', `tab-${state.tab}`);
}

// --- Agent tab -----------------------------------------------------------------

function renderAgent() {
  const settings = state.data.settings ?? {};
  const agent = state.data.agent ?? {};
  const tabStatus = state.data.tabs?.[state.activeTab?.id];
  const out = [];

  out.push(h('section', {},
    h('h2', {}, 'Your agent (WebMCP)'),
    h('div', { class: 'card stack' },
      h('div', { class: 'spread' },
        h('div', {},
          h('strong', {}, agent.enabled === false ? 'Disconnected' : tabStatus?.registered ? 'Connected — tools offered to your browser agent' : state.spreadsheetId ? 'Not yet registered on this tab' : 'Open a spreadsheet'),
          agent.selfReportedName ? h('p', { class: 'small' }, 'Agent identifies as ', h('strong', {}, agent.selfReportedName), h('span', { class: 'muted' }, ' (self-reported)')) : null,
          agent.lastCall ? h('p', { class: 'small muted' }, `Last tool call: ${agent.lastCall.name} · ${ago(agent.lastCall.at)}${agent.lastCall.ok ? '' : ' · failed'}`) : h('p', { class: 'small muted' }, 'No tool calls yet.'),
        ),
        agent.enabled === false
          ? h('button', { class: 'btn primary', onclick: () => withBusy('conn', () => act('agent:setEnabled', { enabled: true })) }, 'Connect agent')
          : h('button', { class: 'btn danger', onclick: () => withBusy('conn', () => act('agent:setEnabled', { enabled: false })) }, 'Disconnect'),
      ),
      tabStatus?.webmcp === 'unavailable' ? h('div', { class: 'callout bad small' }, h('strong', {}, 'WebMCP is not available in this browser. '), tabStatus.reason ?? '', ' Then reload the sheet.') : null,
      tabStatus?.errors?.length ? h('div', { class: 'callout warn small' }, 'Some tools failed to register: ', tabStatus.errors.join('; ')) : null,
      h('p', { class: 'small' }, 'This extension does ', h('strong', {}, 'not'), ' see your agent\'s memory or conversation history. Your agent brings its own context (goals, assumptions) and decides what to share in each tool call.'),
      h('details', {}, h('summary', {}, 'Tools your agent can call'),
        h('ul', { class: 'plain small' }, (state.toolDefs ?? []).map(t => h('li', {}, h('code', {}, t.name), ' ', t.annotations?.readOnlyHint ? badge('read-only', 'b-ok') : t.name === 'propose_changes' ? badge('needs your approval', 'b-warn') : badge('panel only', 'b-info'), h('div', { class: 'muted' }, t.title))))),
    )));

  out.push(h('section', {},
    h('h2', {}, 'This spreadsheet'),
    !state.spreadsheetId
      ? h('div', { class: 'card stack' }, h('p', {}, 'Open a Google Sheet to begin. The extension works through the page with your own Google session — no sign-in or API access needed.'), h('button', { class: 'btn', onclick: () => chrome.tabs.update(state.activeTab.id, { url: 'https://docs.google.com/spreadsheets/create' }) }, 'Create a blank sheet'))
      : renderSheetCard(),
  ));

  if (state.spreadsheetId) {
    out.push(h('section', {}, h('h2', {}, 'Try asking your agent'),
      h('div', { class: 'card small stack' },
        h('p', {}, '“Using our FY26 goals, add a Profit column, forecast revenue for Q4 and chart it.”'),
        h('p', {}, '“What happens to Q4 profit if we cut marketing 10%?”'),
        h('p', {}, '“Save the approved summary to your memory.”'))));
  }
  return out;
}

function renderSheetCard() {
  if (state.sheetInfoError) return h('div', { class: 'card error stack' }, h('strong', {}, 'Could not read this spreadsheet'), h('p', {}, state.sheetInfoError.message), state.sheetInfoError.actionable ? h('p', { class: 'small' }, state.sheetInfoError.actionable) : null, h('button', { class: 'btn', onclick: loadSheetInfo }, 'Retry'));
  const si = state.sheetInfo;
  if (!si) return h('div', { class: 'card muted' }, 'Reading sheet…');
  return h('div', { class: 'card stack' },
    h('div', { class: 'spread' }, h('strong', {}, si.title), si.perm.can_edit === false ? badge('view only', 'b-bad') : si.perm.can_edit ? badge('can edit', 'b-ok') : badge('edit unknown', 'b-warn')),
    si.perm.can_edit === false ? h('div', { class: 'callout bad small' }, 'You have view-only access. Edits are disabled; your agent can still read and analyze. Ask the owner for edit access or make a copy.') : null,
    h('p', { class: 'small muted' }, `Tabs: ${si.tabs.join(', ')} · active: ${si.activeTab}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn link', onclick: () => { state.tab = 'context'; render(); } }, 'See detected structure →'),
      !si.model?.columns?.length && si.perm.can_edit ? h('button', { class: 'btn', disabled: state.ui.busy.has('demo'), onclick: () => withBusy('demo', async () => { await act('demo:plan', { url: state.url, tabId: state.activeTab?.id }); state.tab = 'review'; toast('Review the demo data, then approve to write it'); }) }, 'Load demo FP&A data…') : null),
  );
}

// --- Context tab ---------------------------------------------------------------

function renderContext() {
  const docs = Object.values(state.data.docs ?? {}).sort((a, b) => b.addedAt - a.addedAt);
  const out = [];
  out.push(h('section', {}, h('h2', {}, 'Inherited — from your agent'),
    h('div', { class: 'card small' }, 'Company goals, assumptions and history stay in your agent\'s own memory. They are not copied here. When your agent uses them, it must cite them as ', badge('agent memory', 'b-info'), ' — shown to you as not verified by this extension.')));

  out.push(h('section', {}, h('h2', {}, 'Added by you'),
    h('div', { class: 'card stack' },
      h('label', { class: 'field', for: 'docFile' }, 'Upload documents (.txt, .md, .csv, .json)'),
      h('input', { id: 'docFile', type: 'file', multiple: true, accept: '.txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json', onchange: e => uploadDocs(e.target) }),
      h('label', { class: 'field', for: 'noteCat' }, 'Or add a goal / assumption'),
      h('div', { class: 'row' },
        h('select', { id: 'noteCat', style: 'width:auto' }, h('option', { value: 'goal' }, 'Goal'), h('option', { value: 'assumption' }, 'Assumption')),
        h('input', { id: 'noteText', type: 'text', placeholder: 'e.g. Q4 revenue target: $1.8M', style: 'flex:1;width:auto' }),
        h('button', { class: 'btn', onclick: () => withBusy('note', async () => {
          const text = $('#noteText').value.trim();
          if (!text) throw new Error('Type a goal or assumption first');
          const cat = $('#noteCat').value;
          await act('docs:add', { doc: { name: text.slice(0, 60), category: cat, text, provenance: 'entered by user' } });
          $('#noteText').value = '';
          toast(`${cat === 'goal' ? 'Goal' : 'Assumption'} added`);
        }) }, 'Add')),
    ),
    renderConflicts(docs),
    docs.length ? docs.map(d => h('div', { class: 'card' },
      h('div', { class: 'spread' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.active, 'aria-label': `Use ${d.name}`, onchange: e => withBusy('t' + d.id, () => act('docs:toggle', { id: d.id, active: e.target.checked })) }),
          h('span', {}, h('strong', {}, d.name), h('br'), h('span', { class: 'small muted' }, `${d.category} · ${d.provenance} · ${fmtTime(d.addedAt)} · ${d.text.length.toLocaleString()} chars`))),
        h('button', { class: 'btn link', onclick: () => withBusy('r' + d.id, () => act('docs:remove', { id: d.id })), 'aria-label': `Remove ${d.name}` }, 'Remove')),
      h('details', {}, h('summary', { class: 'small' }, 'View'), h('pre', {}, d.text.slice(0, 5000))),
      !d.active ? h('p', { class: 'small muted' }, 'Deselected — not available to your agent.') : null,
    )) : h('div', { class: 'empty' }, 'No documents added.')));

  out.push(h('section', {}, h('h2', {}, 'Inferred — detected from the sheet'), renderStructure()));
  return out;
}

function renderConflicts(docs) {
  const conflicts = detectConflictsLocal(docs.filter(d => d.active));
  if (!conflicts.length) return null;
  return h('div', { class: 'callout warn small' }, h('strong', {}, 'Conflicting sources: '),
    conflicts.map(c => h('div', {}, `“${c.key}”: `, c.values.map(v => `${v.value} (${v.doc})`).join(' vs '))));
}

// Mirrors the service worker's detection for instant feedback.
function detectConflictsLocal(docs) {
  const seen = new Map();
  for (const d of docs) for (const line of d.text.split(/\n/)) {
    const m = /^\s*[-*]?\s*([A-Za-z][A-Za-z0-9 %&/()'-]{2,60}?)\s*[:=]\s*(.+?)\s*$/.exec(line);
    if (!m || !/\d/.test(m[2])) continue;
    const key = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    seen.set(key, [...(seen.get(key) ?? []), { doc: d.name, id: d.id, value: m[2] }]);
  }
  return [...seen.entries()].filter(([, v]) => new Set(v.map(x => x.value)).size > 1 && new Set(v.map(x => x.id)).size > 1).map(([key, values]) => ({ key, values }));
}

async function uploadDocs(input) {
  for (const f of input.files) {
    await withBusy('up' + f.name, async () => {
      if (f.size > 2_000_000) throw new Error(`${f.name} is larger than 2 MB`);
      if (!/\.(txt|md|markdown|csv|json)$/i.test(f.name)) throw new Error(`${f.name}: unsupported type (use .txt, .md, .csv or .json)`);
      const text = await f.text();
      await act('docs:add', { doc: { name: f.name, category: 'document', text, provenance: 'uploaded by user' } });
      toast(`Added ${f.name}`);
    });
  }
  input.value = '';
}

function renderStructure() {
  if (!state.spreadsheetId) return h('div', { class: 'empty' }, 'Open a spreadsheet.');
  const m = state.sheetInfo?.model;
  if (!m) return h('div', { class: 'card muted' }, 'Reading sheet…');
  return h('div', { class: 'card stack' },
    h('div', { class: 'spread' }, h('span', {}, `Tab “${m.sheetTitle}”`, m.headerRow ? ` · header row ${m.headerRow} · data rows ${m.dataStartRow}–${m.dataEndRow}` : ''), h('button', { class: 'btn link', onclick: loadSheetInfo }, 'Refresh')),
    m.period_range ? h('p', { class: 'small' }, `Periods: ${m.period_range.first} → ${m.period_range.last} (${m.period_granularity})`) : null,
    m.columns.length ? h('table', { class: 'cells' }, h('thead', {}, h('tr', {}, h('th', {}, 'Col'), h('th', {}, 'Header'), h('th', {}, 'Type'), h('th', {}, 'Range'))),
      h('tbody', {}, m.columns.map(c => h('tr', {}, h('td', { class: 'addr' }, c.letter), h('td', {}, c.name ?? '—'), h('td', {}, c.type + (c.currency ? ` (${c.currency})` : '') + (c.has_formulas ? ' · ƒ' : '')), h('td', {}, rangeLink(c.range)))))) : null,
    m.gaps.length ? h('div', { class: 'callout warn small' }, h('strong', {}, 'Missing values: '), m.gaps.join(', '), ' — never filled in automatically.') : null,
    m.ambiguities.length ? h('div', { class: 'callout warn small' }, h('strong', {}, 'Needs clarification: '), m.ambiguities.map(a => h('div', {}, a.message))) : null,
  );
}

// --- Review tab ----------------------------------------------------------------

function renderReview() {
  const plans = forSheet('plans');
  if (!state.spreadsheetId) return [h('div', { class: 'empty' }, 'Open a spreadsheet.')];
  const active = plans.filter(p => ['pending_approval', 'executing'].includes(p.status));
  const past = plans.filter(p => !active.includes(p));
  return [
    h('section', {}, h('h2', {}, 'Awaiting your decision'),
      active.length ? active.map(renderPlan) : h('div', { class: 'empty' }, 'No proposed changes. Nothing will be written to your sheet unless you approve it here.')),
    past.length ? h('section', {}, h('h2', {}, 'Decided'), past.map(p => {
      const [label, cls] = STATUS[p.status] ?? [p.status, 'b-neutral'];
      const open = state.ui.openPlans?.has(p.id);
      return h('details', { class: 'card', open, ontoggle: e => { state.ui.openPlans ??= new Set(); e.target.open ? state.ui.openPlans.add(p.id) : state.ui.openPlans.delete(p.id); render(); } },
        h('summary', {}, h('span', { class: 'spread', style: 'display:inline-flex;width:calc(100% - 20px)' }, h('span', {}, p.title, h('span', { class: 'small muted' }, ` · ${fmtTime(p.createdAt)}`)), badge(label, cls))),
        open ? renderPlan(p) : null);
    })) : null,
  ];
}

function renderPlan(plan) {
  const [label, cls] = STATUS[plan.status] ?? [plan.status, 'b-neutral'];
  const pending = plan.status === 'pending_approval';
  const sel = state.ui.opSel[plan.id] ??= Object.fromEntries(plan.ops.map(o => [o.index, !o.errors.length]));
  const results = plan.execution?.results ?? [];
  const body = [
    h('div', { class: 'spread' }, h('div', {}, h('h3', {}, plan.title), h('p', { class: 'small muted' }, `${plan.origin === 'agent' ? 'Proposed by your agent' : 'Created by you'} · ${fmtTime(plan.createdAt)}`)), badge(label, cls)),
    plan.rationale ? h('p', {}, plan.rationale) : null,
    plan.assumptions?.length ? h('div', {}, h('strong', { class: 'small' }, 'Assumptions'), h('ul', { class: 'small', style: 'margin:2px 0;padding-left:18px' }, plan.assumptions.map(a => h('li', {}, a)))) : null,
    plan.status === 'stale' ? h('div', { class: 'callout bad small' }, `${plan.staleReason}. This preview is no longer valid — ask your agent to propose again.`) : null,
    plan.status === 'invalid' ? h('div', { class: 'callout bad small' }, 'This plan failed validation. Nothing can be applied.') : null,
    plan.decision?.feedback ? h('p', { class: 'small' }, h('strong', {}, 'Your feedback: '), plan.decision.feedback) : null,
    plan.ops.map(op => renderOp(plan, op, sel, results.find(r => r.index === op.index))),
  ];
  if (plan.execution) {
    const v = plan.execution.verification;
    body.push(h('div', { class: `callout small ${v.ok && plan.status === 'executed' ? '' : 'warn'}` },
      h('strong', {}, plan.status === 'executed' ? 'Applied and verified. ' : plan.status === 'partial_failure' ? 'Partially applied. ' : plan.status === 'failed' ? 'Failed — may be partially applied. ' : plan.status === 'reverted' ? 'Reverted. ' : 'Applied with issues. '),
      `${results.filter(r => r.status === 'succeeded').length} succeeded · ${results.filter(r => r.status === 'failed').length} failed · ${results.filter(r => r.status === 'not_attempted').length} not attempted · ${results.filter(r => r.status === 'skipped_not_approved').length} not approved. `,
      `Re-read ${v.checked_cells} cell(s): ${v.ok ? 'all match the approved operations.' : `${v.issues.length} issue(s).`}`,
      v.issues?.length ? h('ul', {}, v.issues.slice(0, 10).map(i => h('li', {}, h('code', {}, i.cell), ': ', i.issues.join('; ')))) : null,
      plan.status === 'partial_failure' ? h('p', {}, 'Recovery: completed operations remain applied. Revert them below, or ask your agent to re-propose the failed part.') : null,
    ));
    if (['executed', 'executed_with_issues', 'partial_failure', 'failed'].includes(plan.status)) {
      body.push(h('div', { class: 'row' }, h('button', { class: 'btn danger', disabled: state.ui.busy.has('rev' + plan.id), onclick: () => revert(plan) }, 'Revert these changes')));
    }
    if (plan.revert) body.push(h('p', { class: 'small muted' }, `Reverted ${fmtTime(plan.revertedAt)}: restored ${plan.revert.restored_cells} cells${plan.revert.removed_charts.length ? `, removed ${plan.revert.removed_charts.length} chart(s)` : ''}${plan.revert.deleted_sheets.length ? `, deleted tab(s) ${plan.revert.deleted_sheets.join(', ')}` : ''}.${plan.revert.manual_steps?.length ? ` Manual step needed: ${plan.revert.manual_steps.join('; ')}` : ''}`));
  }
  if (pending) {
    const nSel = Object.values(sel).filter(Boolean).length;
    body.push(h('div', { class: 'stack', style: 'margin-top:10px' },
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: !nSel || state.ui.busy.has('ap' + plan.id), onclick: () => approve(plan) }, state.ui.busy.has('ap' + plan.id) ? 'Applying…' : `Approve & apply ${nSel === plan.ops.length ? 'all' : `${nSel} of ${plan.ops.length}`}`),
        h('button', { class: 'btn danger', onclick: () => decide(plan, 'reject') }, 'Reject')),
      h('label', { class: 'field', for: 'fb-' + plan.id }, 'Request a revision'),
      h('textarea', { id: 'fb-' + plan.id, placeholder: 'e.g. Use a linear trend instead, and put the chart on a new tab.', oninput: e => (state.ui.feedback[plan.id] = e.target.value) }, state.ui.feedback[plan.id] ?? ''),
      h('div', {}, h('button', { class: 'btn', onclick: () => decide(plan, 'revise') }, 'Send revision request to agent')),
      h('p', { class: 'small muted' }, 'Approved operations are executed exactly as previewed. If the sheet changes before you approve, this plan becomes stale.')));
  }
  return h('div', { class: `card ${pending ? 'pending' : plan.status === 'stale' || plan.status === 'invalid' ? 'stale' : ''}` }, body);
}

function renderOp(plan, op, sel, result) {
  const pending = plan.status === 'pending_approval';
  const writes = op.writes ?? [];
  const shown = writes.slice(0, 40);
  return h('div', { class: `op ${op.errors.length ? 'invalid' : ''}` },
    h('div', { class: 'spread' },
      pending && !op.errors.length
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: sel[op.index], onchange: e => { sel[op.index] = e.target.checked; render(); } }), h('span', {}, h('strong', {}, `${op.index + 1}. `), op.summary || op.kind))
        : h('span', {}, h('strong', {}, `${op.index + 1}. `), op.summary || op.kind),
      result ? badge(result.status.replace(/_/g, ' '), result.status === 'succeeded' ? 'b-ok' : result.status === 'failed' ? 'b-bad' : 'b-neutral') : null),
    op.errors.length ? h('ul', { class: 'errors small' }, op.errors.map(e => h('li', {}, e))) : null,
    op.warnings.length ? h('ul', { class: 'warnings small' }, op.warnings.map(e => h('li', {}, e))) : null,
    result?.error ? h('p', { class: 'small', style: 'color:var(--red)' }, `Error: ${result.error}`) : null,
    op.forecast ? h('p', { class: 'small' }, badge('projection', 'b-info'), ' ', op.forecast.assumptions.join(' ')) : null,
    op.formatRequests?.length ? h('p', { class: 'small muted' }, `Formatting: ${op.formatRequests.map(f => f.label).join('; ')}`) : null,
    op.chartPreview ? chartSvg(op.chartPreview) : null,
    writes.length ? h('table', { class: 'cells' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Cell'), h('th', {}, 'Before'), h('th', {}, 'After'), h('th', { class: 'num' }, result ? 'Sheets value' : 'Expected'))),
      h('tbody', {}, shown.map(w => h('tr', {},
        h('td', { class: 'addr' }, w.a1.replace(/^.*!/, '')),
        h('td', { class: 'before' }, w.before.formula ?? (w.before.text || '∅')),
        h('td', { class: 'after mono' }, String(w.content ?? '∅')),
        h('td', { class: 'num' }, w.after ? (w.after.text || fmtNum(w.after.value)) : w.kind === 'formula' ? (Number.isFinite(w.expected) ? fmtNum(w.expected) : h('span', { class: 'muted small' }, w.expectedNote ?? '')) : ''))))) : null,
    writes.length > shown.length ? h('p', { class: 'small muted' }, `…and ${writes.length - shown.length} more cell(s)`) : null,
  );
}

function chartSvg(p) {
  const W = 320, H = 170, L = 44, R = 8, T = 22, B = 30;
  const all = p.series.flatMap(s => s.values).filter(Number.isFinite);
  if (!all.length) return h('p', { class: 'small muted' }, 'No numeric data to preview.');
  const min = Math.min(0, ...all), max = Math.max(...all);
  const n = p.labels.length;
  const x = i => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = v => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
  const colors = ['#0f624a', '#1f4fa3', '#8a5300', '#6b3fa0'];
  const ns = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${p.type.toLowerCase()} chart preview: ${p.title}` });
  svg.append(s('text', { x: L, y: 14, 'font-size': 11, 'font-weight': 600, fill: '#17201b' }, p.title));
  for (const t of [min, (min + max) / 2, max]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), stroke: '#ece9e0' }));
    svg.append(s('text', { x: L - 4, y: y(t) + 3, 'font-size': 9, 'text-anchor': 'end', fill: '#5f6b64' }, Math.abs(t) >= 1000 ? `${Math.round(t / 1000)}k` : Math.round(t)));
  }
  if (p.projectedFrom > 0) svg.append(s('rect', { x: x(p.projectedFrom) - 4, y: T, width: W - R - x(p.projectedFrom) + 4, height: H - T - B, fill: '#e7eefb' }), s('text', { x: W - R - 2, y: T + 10, 'font-size': 9, 'text-anchor': 'end', fill: '#1f4fa3' }, 'forecast'));
  p.series.forEach((ser, si) => {
    const c = colors[si % colors.length];
    if (p.type === 'LINE') {
      const pts = ser.values.map((v, i) => (Number.isFinite(v) ? `${x(i)},${y(v)}` : null)).filter(Boolean);
      svg.append(s('polyline', { points: pts.join(' '), fill: 'none', stroke: c, 'stroke-width': 2 }));
    } else {
      const bw = Math.max(2, ((W - L - R) / n / p.series.length) * 0.7);
      ser.values.forEach((v, i) => { if (Number.isFinite(v)) svg.append(s('rect', { x: x(i) - (bw * p.series.length) / 2 + si * bw, y: y(Math.max(v, 0)), width: bw, height: Math.abs(y(v) - y(0)), fill: c })); });
    }
  });
  const step = Math.ceil(n / 6);
  p.labels.forEach((l, i) => { if (i % step === 0) svg.append(s('text', { x: x(i), y: H - B + 12, 'font-size': 9, 'text-anchor': 'middle', fill: '#5f6b64' }, l)); });
  p.series.forEach((ser, si) => svg.append(s('text', { x: L + si * 90, y: H - 4, 'font-size': 9.5, fill: colors[si % colors.length] }, `■ ${ser.name}`)));
  return svg;
}

async function approve(plan) {
  const sel = state.ui.opSel[plan.id];
  const approvedIndexes = Object.entries(sel).filter(([, v]) => v).map(([k]) => Number(k));
  await withBusy('ap' + plan.id, async () => {
    const r = await act('plan:approve', { planId: plan.id, approvedIndexes });
    if (r.status === 'stale') toast('The sheet changed after the preview — plan invalidated. Ask your agent to re-propose.', true);
    else if (r.status === 'executed') toast('Applied and verified');
    else toast(`Finished: ${STATUS[r.status]?.[0] ?? r.status}`, r.status !== 'executed_with_issues');
  });
}

async function decide(plan, decision) {
  const feedback = state.ui.feedback[plan.id] ?? '';
  if (decision === 'revise' && !feedback.trim()) return toast('Describe what to change first', true);
  await withBusy('dec' + plan.id, async () => {
    await act('plan:decide', { planId: plan.id, decision, feedback });
    toast(decision === 'revise' ? 'Revision requested — your agent sees your feedback via get_plan_status' : 'Rejected. Nothing was written.');
  });
}

async function revert(plan) {
  await withBusy('rev' + plan.id, async () => {
    let r = await act('plan:revert', { planId: plan.id, force: false });
    if (!r.ok) {
      if (!confirm(`${r.message}\n\nRevert anyway and overwrite those later edits?`)) return;
      r = await act('plan:revert', { planId: plan.id, force: true });
    }
    toast(r.manual_steps?.length ? `Reverted ${r.restored_cells} cell(s). Still to do: ${r.manual_steps.join('; ')}` : `Reverted ${r.restored_cells} cell(s)`, !!r.manual_steps?.length);
  });
}

// --- Analysis tab --------------------------------------------------------------

function renderAnalysis() {
  if (!state.spreadsheetId) return [h('div', { class: 'empty' }, 'Open a spreadsheet.')];
  const insights = forSheet('insights');
  const forecasts = forSheet('forecasts');
  const scenarios = forSheet('scenarios');
  const metrics = forSheet('metrics');
  const docs = state.data.docs ?? {};
  const src = s => h('li', {},
    s.type === 'sheet_range' ? [badge('sheet', 'b-ok'), ' ', s.verified ? rangeLink(s.ref, s.gid) : h('code', {}, s.ref)]
      : s.type === 'uploaded_document' ? [badge('your doc', 'b-ok'), ' ', docs[s.ref]?.name ?? s.name ?? s.ref]
      : s.type === 'metric' ? [badge('computed', 'b-ok'), ' ', h('code', {}, s.ref)]
      : [badge('agent memory · unverified', 'b-info'), ' ', s.ref],
    s.note ? h('span', { class: 'muted' }, ` — ${s.note}`) : null,
    s.problem ? h('span', { style: 'color:var(--red)' }, ` ⚠ ${s.problem}`) : null);
  return [
    h('section', {}, h('h2', {}, 'Insights'),
      insights.length ? insights.map(i => h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('h3', {}, i.title), h('span', { class: 'small muted' }, fmtTime(i.createdAt))),
        i.problems.length ? h('div', { class: 'callout warn small' }, h('strong', {}, 'Citation problems: '), i.problems.join('; ')) : null,
        i.findings.length ? h('div', {}, h('h2', {}, 'Findings · from data'), i.findings.map(f => h('div', { class: 'card' }, h('p', {}, f.grounded ? null : badge('uncited', 'b-bad'), ' ', f.statement), h('ul', { class: 'plain small' }, f.evidence.map(src))))) : null,
        i.suggestions.length ? h('div', {}, h('h2', {}, 'Suggestions · recommendations, not facts'), i.suggestions.map(s => h('div', { class: 'card' }, h('div', { class: 'spread' }, h('p', {}, s.statement), badge(`${s.confidence} confidence`, s.confidence === 'high' ? 'b-ok' : s.confidence === 'low' ? 'b-warn' : 'b-neutral')), s.rationale ? h('p', { class: 'small muted' }, s.rationale) : null, h('ul', { class: 'plain small' }, s.sources.map(src))))) : null,
      )) : h('div', { class: 'empty' }, 'Your agent posts grounded insights here with post_insights.')),
    h('section', {}, h('h2', {}, 'Forecasts'),
      forecasts.length ? forecasts.map(f => h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('strong', {}, `${f.series.map(s => s.column).join(', ')} · ${f.method.replace('_', ' ')}`), f.written ? badge('written to sheet', 'b-ok') : badge('not written', 'b-neutral')),
        h('table', { class: 'cells' }, h('thead', {}, h('tr', {}, h('th', {}, 'Period'), f.series.map(s => h('th', { class: 'num' }, s.column)))),
          h('tbody', {}, f.periodLabels.map((p, i) => h('tr', {}, h('td', {}, badge('proj', 'b-info'), ' ', p ?? `+${i + 1}`), f.series.map(s => h('td', { class: 'num' }, fmtNum(s.projections[i]))))))),
        h('ul', { class: 'small', style: 'margin:0;padding-left:18px' }, f.assumptions.map(a => h('li', {}, a)), f.series.flatMap(s => s.warnings).map(w => h('li', { style: 'color:var(--amber)' }, w))),
      )) : h('div', { class: 'empty' }, 'No forecasts yet.')),
    h('section', {}, h('h2', {}, 'What-if scenarios'),
      scenarios.length ? scenarios.map(s => {
        const r = s.result;
        return h('div', { class: 'card hyp stack' },
          h('div', { class: 'spread' }, h('strong', {}, s.name), badge('hypothetical', 'b-hyp')),
          h('p', { class: 'small' }, r.changed_assumptions.join('; '), h('span', { class: 'muted' }, ` · basis: ${r.basis}`)),
          h('table', { class: 'cells' }, h('thead', {}, h('tr', {}, h('th', {}), h('th', { class: 'num' }, 'Baseline'), h('th', { class: 'num' }, 'Scenario'), h('th', { class: 'num' }, 'Δ'))),
            h('tbody', {}, [['Revenue', 'revenue', 'revenue_change'], ['Total cost', 'cost', 'cost_change'], ['Profit', 'profit', 'profit_change'], ['Margin %', 'margin_pct', 'margin_change_pts']].map(([l, k, d]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, fmtNum(r.baseline[k])), h('td', { class: 'num' }, fmtNum(r.scenario[k])), h('td', { class: 'num' }, fmtNum(r.impact[d])))))),
          h('p', { class: 'small muted' }, 'Baseline data in the sheet is unchanged.'),
          h('button', { class: 'btn', disabled: state.ui.busy.has('scn' + s.id), onclick: () => withBusy('scn' + s.id, async () => { await act('scenario:toPlan', { scenarioId: s.id, url: state.url, tabId: state.activeTab?.id }); state.tab = 'review'; toast('Preview created — review and approve to save to a new tab'); }) }, 'Save to new tab…'));
      }) : h('div', { class: 'empty' }, 'Ask your agent for a what-if (e.g. “cut marketing 10%”).')),
    metrics.length ? h('section', {}, h('h2', {}, 'Computed metrics'), metrics.slice(0, 5).map(m => h('details', { class: 'card' }, h('summary', { class: 'small' }, `${fmtTime(m.createdAt)} · ${m.summary}`), h('pre', {}, JSON.stringify(m.result, null, 1).slice(0, 6000))))) : null,
  ];
}

// --- Sync tab ------------------------------------------------------------------

function renderSync() {
  if (!state.spreadsheetId) return [h('div', { class: 'empty' }, 'Open a spreadsheet.')];
  const syncs = Object.values(state.data.syncs ?? {}).filter(s => s.spreadsheetId === state.spreadsheetId).sort((a, b) => b.approvedAt - a.approvedAt);
  const cands = state.syncCandidates;
  const sel = state.ui.syncSel ??= cands ? Object.fromEntries(cands.map(c => [c.id, c.checked])) : null;
  const out = [];
  out.push(h('section', {}, h('h2', {}, 'How sync works'),
    h('div', { class: 'card small' }, 'You choose what to keep and approve it here. Your agent then fetches it (get_approved_summary) and saves it to ', h('strong', {}, 'its own memory'), '. The extension shows where your agent reports it was saved, but cannot verify your agent\'s memory itself. Hypothetical scenarios are excluded unless you include them.')));
  out.push(h('section', {}, h('div', { class: 'spread' }, h('h2', {}, 'Build a summary'), h('button', { class: 'btn link', onclick: loadSyncCandidates }, 'Refresh')),
    !cands ? h('div', { class: 'card muted' }, 'Loading…')
      : !cands.length ? h('div', { class: 'empty' }, 'Nothing to summarize yet — approve changes, forecasts or insights first.')
      : h('div', { class: 'card stack' },
        cands.map(c => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: sel[c.id], onchange: e => { sel[c.id] = e.target.checked; render(); } }),
          h('span', {}, badge(c.label, c.kind === 'scenario' ? 'b-hyp' : c.kind === 'suggestion' ? 'b-warn' : c.label.includes('UNVERIFIED') ? 'b-bad' : c.kind === 'forecast' ? 'b-info' : 'b-ok'), ' ', h('span', { class: 'small' }, c.text)))),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: !Object.values(sel).some(Boolean) || state.ui.busy.has('sync'), onclick: () => withBusy('sync', async () => {
            const items = cands.filter(c => sel[c.id]);
            await act('sync:approve', { spreadsheetId: state.spreadsheetId, sheetTitle: state.sheetInfo?.title ?? 'Spreadsheet', items });
            toast('Approved. Ask your agent to save the approved summary.');
          }) }, 'Approve summary for my agent'),
          h('button', { class: 'btn', disabled: !Object.values(sel).some(Boolean), onclick: () => exportLocal(cands.filter(c => sel[c.id])) }, 'Export .md (local only)')),
      )));
  out.push(h('section', {}, h('h2', {}, 'Approved summaries'),
    syncs.length ? syncs.map(s => h('div', { class: 'card stack' },
      h('div', { class: 'spread' }, h('strong', {}, `${s.items.length} item(s) · ${fmtTime(s.approvedAt)}`),
        s.status === 'agent_reported_saved' ? badge('agent reports saved', 'b-ok') : s.status === 'delivered' ? badge('fetched by agent — awaiting confirmation', 'b-warn') : badge('waiting for agent', 'b-neutral')),
      h('div', { class: 'timeline' },
        h('span', { class: 'done' }, '✓ Approved by you'),
        h('span', { class: s.deliveredAt ? 'done' : '' }, `${s.deliveredAt ? '✓' : '○'} Fetched by agent`),
        h('span', { class: s.savedAt ? 'done' : '' }, `${s.savedAt ? '✓' : '○'} Agent-reported saved`)),
      s.destination ? h('p', { class: 'small' }, 'Destination (reported by agent): ', h('strong', {}, s.destination), s.reference ? [' · ', h('code', {}, s.reference)] : null) : null,
      s.includesHypothetical ? h('p', { class: 'small' }, badge('includes hypothetical', 'b-hyp'), ' labeled as such in the summary.') : null,
      h('details', {}, h('summary', { class: 'small' }, 'View summary'), h('pre', {}, s.markdown)),
    )) : h('div', { class: 'empty' }, 'None yet.')));
  return out;
}

async function loadSyncCandidates() {
  if (!state.spreadsheetId) return;
  try { state.syncCandidates = await act('sync:candidates', { spreadsheetId: state.spreadsheetId }); state.ui.syncSel = null; } catch (e) { toast(e.message, true); state.syncCandidates = []; }
  render();
}

function exportLocal(items) {
  const md = `<!-- LOCAL EXPORT — not synced to any agent memory -->\n# Analysis summary — ${state.sheetInfo?.title ?? ''}\n\n${items.map(i => `- [${i.label}] ${i.text}`).join('\n')}\n`;
  const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `byoa-summary-${new Date().toISOString().slice(0, 10)}.md` });
  a.click();
  act('sync:exported', { spreadsheetId: state.spreadsheetId }).catch(() => {});
  toast('Saved a local file. This is not a sync to your agent.');
}

// --- History tab ---------------------------------------------------------------

function renderHistory() {
  const filters = { all: () => true, errors: e => e.status === 'error' || e.status === 'partial', plans: e => e.type.startsWith('plan_'), tools: e => e.type === 'tool_call', context: e => e.type.startsWith('context_') || e.type.startsWith('sync_') };
  const f = state.ui.historyFilter;
  const events = (state.data.audit ?? []).filter(e => !e.spreadsheetId || e.spreadsheetId === state.spreadsheetId).filter(filters[f]);
  const icon = s => (s === 'ok' ? badge('ok', 'b-ok') : s === 'error' ? badge('error', 'b-bad') : s === 'partial' ? badge('partial', 'b-warn') : badge('info', 'b-neutral'));
  return [
    h('div', { class: 'row', style: 'margin-bottom:8px', role: 'group', 'aria-label': 'Filter history' },
      Object.keys(filters).map(k => h('button', { class: `btn ${k === f ? 'primary' : ''}`, 'aria-pressed': k === f, onclick: () => { state.ui.historyFilter = k; render(); } }, k))),
    events.length ? h('div', { class: 'card' }, h('ul', { class: 'plain' }, events.slice(0, 300).map(e => h('li', {},
      h('div', { class: 'spread' }, h('span', {}, icon(e.status), ' ', e.summary), h('span', { class: 'small muted', style: 'white-space:nowrap' }, fmtTime(e.ts))),
      e.detail ? h('details', {}, h('summary', { class: 'small' }, e.type), h('pre', {}, JSON.stringify(e.detail, null, 1))) : null)))) : h('div', { class: 'empty' }, 'No events.'),
  ];
}

// --- render loop ---------------------------------------------------------------

const RENDER = { agent: renderAgent, context: renderContext, review: renderReview, analysis: renderAnalysis, sync: renderSync, history: renderHistory };
let deferred = false;
function render() {
  renderHeader();
  const ae = document.activeElement;
  if (ae && main.contains(ae) && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type === 'text'))) {
    if (!deferred) { deferred = true; ae.addEventListener('blur', () => { deferred = false; render(); }, { once: true }); }
    return;
  }
  const scroll = window.scrollY;
  main.replaceChildren(...[RENDER[state.tab]()].flat(Infinity).filter(Boolean));
  window.scrollTo(0, scroll);
}

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  selectTab(b.dataset.tab);
});
document.querySelector('.tabs').addEventListener('keydown', e => {
  const tabs = [...document.querySelectorAll('.tabs button')];
  const i = tabs.findIndex(t => t.dataset.tab === state.tab);
  const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  selectTab(tabs[next].dataset.tab);
  tabs[next].focus();
});
function selectTab(t) {
  state.tab = t;
  if (t === 'sync') loadSyncCandidates();
  render();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  for (const [k, v] of Object.entries(changes)) state.data[k] = v.newValue;
  if (changes.plans) {
    // Refresh sheet structure after executions/reverts.
    const prev = changes.plans.oldValue ?? {};
    if (Object.values(changes.plans.newValue ?? {}).some(p => p.status !== prev[p.id]?.status && ['executed', 'executed_with_issues', 'partial_failure', 'reverted'].includes(p.status))) loadSheetInfo();
  }
  render();
});
chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === state.activeTab?.id && (info.url || info.status === 'complete')) refreshActiveTab(); });

// Source-version check: pending previews are invalidated as soon as the sheet changes.
setInterval(async () => {
  for (const p of forSheet('plans').filter(p => p.status === 'pending_approval')) {
    if (state.ui.busy.has('ap' + p.id)) continue;
    try { await act('plan:checkStale', { planId: p.id }); } catch { /* transient */ }
  }
}, 5000);
setInterval(() => { if (state.tab === 'agent') render(); }, 15000);

(async () => {
  await loadAll();
  state.toolDefs = await act('tools:defs').catch(() => []);
  await refreshActiveTab();
})();
