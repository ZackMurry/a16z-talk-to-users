// On-sheet preview of a proposed plan: ghost cells drawn over the target range (positioned from
// Sheets' own selection element) plus an Accept / Reject card. Runs in the isolated world next to
// driver.js. The UI lives in a closed shadow root and only reacts to trusted (real user) clicks,
// so page scripts can neither read it nor approve on the user's behalf.
(() => {
  if (window.__byoaPreview) return;
  window.__byoaPreview = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let cur = null; // { preview, host, root, card, ghosts, geom, raf, staleTimer, state }

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: Arial, sans-serif; }
    .ghosts { position: absolute; inset: 0; }
    .g { position: absolute; box-sizing: border-box; background: rgba(26,115,232,.10); border: 1px dashed rgba(26,115,232,.75);
         color: #174ea6; font: 13px Arial, sans-serif; line-height: 20px; padding: 0 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .g.num { text-align: right; }
    .g.over { background: rgba(234,134,0,.14); border-color: rgba(234,134,0,.85); color: #8a4b00; }
    .g.chart { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: rgba(26,115,232,.06); white-space: normal; text-align: center; font-size: 14px; }
    .card { position: absolute; width: 320px; pointer-events: auto; background: #fff; color: #1f1f1f; border-radius: 12px;
            box-shadow: 0 6px 24px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06); padding: 14px 16px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .eyebrow { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #5f6368; display: flex; align-items: center; gap: 6px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #1a73e8; }
    .dot.warn { background: #e37400; } .dot.bad { background: #d93025; } .dot.ok { background: #188038; }
    h3 { font-size: 15px; margin: 6px 0 4px; font-weight: 600; }
    p { margin: 4px 0; color: #3c4043; }
    ul { margin: 6px 0; padding-left: 18px; color: #3c4043; }
    li.err { color: #d93025; } li.warnl { color: #b06000; }
    details { margin: 4px 0; color: #5f6368; } summary { cursor: pointer; }
    .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    button { font: 600 13px system-ui, sans-serif; border-radius: 18px; padding: 7px 16px; cursor: pointer; border: 1px solid #dadce0; background: #fff; color: #1f1f1f; }
    button.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
    button.link { border: 0; padding: 0; background: none; color: #1a73e8; font-weight: 500; }
    button:disabled { opacity: .5; cursor: default; }
    button:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
    textarea { width: 100%; box-sizing: border-box; font: 13px system-ui, sans-serif; border: 1px solid #dadce0; border-radius: 8px; padding: 6px 8px; min-height: 54px; margin-top: 8px; }
    .muted { color: #5f6368; font-size: 12px; }
    .spin { width: 14px; height: 14px; border: 2px solid #c6dafc; border-top-color: #1a73e8; border-radius: 50%; animation: s 0.8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), ev => { if (ev.isTrusted) v(ev); });
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  const send = msg => chrome.runtime.sendMessage({ channel: 'panel', ...msg });

  function gridRect() {
    const g = document.querySelector('#waffle-grid-container, .grid-container');
    return g ? g.getBoundingClientRect() : { top: 140, left: 0, right: innerWidth, bottom: innerHeight, width: innerWidth };
  }

  async function show(preview) {
    hide();
    const host = el('div', { 'data-byoa-preview': '' });
    const root = host.attachShadow({ mode: 'closed' });
    const layer = el('div', { class: 'layer' });
    const ghosts = el('div', { class: 'ghosts' });
    const card = el('div', { class: 'card', role: 'dialog', 'aria-label': `Proposed change: ${preview.title}` });
    root.append(el('style', {}, CSS), layer);
    layer.append(ghosts, card);
    document.documentElement.append(host);
    cur = { preview, host, root, layer, ghosts, card, geom: null, state: 'pending', feedback: false };
    renderCard();
    placeCard();
    if (preview.box) {
      try {
        cur.geom = await window.__byoaDriver.run('previewGeometry', { sheet: preview.sheet, box: preview.box }, { restoreView: false });
      } catch (e) { cur.geomError = e.message; }
      if (!cur) return;
      buildGhosts();
      loop();
    }
    cur.staleTimer = setInterval(checkStale, 6000);
    renderCard();
  }

  function hide(planId) {
    if (!cur || (planId && cur.preview.planId !== planId)) return;
    cancelAnimationFrame(cur.raf);
    clearInterval(cur.staleTimer);
    cur.host.remove();
    cur = null;
  }

  async function checkStale() {
    if (!cur || cur.state !== 'pending') return;
    const r = await send({ type: 'plan:checkStale', planId: cur.preview.planId }).catch(() => null);
    if (cur && r?.ok && r.result.status === 'stale') { cur.state = 'stale'; cur.ghosts.replaceChildren(); renderCard(); }
    else if (cur && r?.ok && r.result.status && !['pending_approval', 'executing'].includes(r.result.status)) hide();
  }

  // --- ghosts ------------------------------------------------------------------------
  function buildGhosts() {
    const { preview, geom, ghosts } = cur;
    ghosts.replaceChildren();
    if (!geom) return;
    const { box } = preview;
    const colX = [0], rowY = [0];
    geom.colWidths.forEach((w, i) => colX.push(colX[i] + w));
    geom.rowHeights.forEach((h, i) => rowY.push(rowY[i] + h));
    cur.ghostEls = [];
    for (const g of preview.ghosts) {
      const c = g.col - box.startCol, r = g.row - box.startRow;
      if (c < 0 || r < 0 || c >= geom.colWidths.length || r >= geom.rowHeights.length) continue;
      const d = el('div', { class: `g${g.numeric ? ' num' : ''}${g.overwrites ? ' over' : ''}`, title: g.formula ? `${g.formula}${g.display ? ` → ${g.display}` : ''}` : (g.overwrites ? `replaces "${g.before}"` : '') }, g.display ?? '');
      d._x = colX[c]; d._y = rowY[r]; d._w = geom.colWidths[c]; d._h = geom.rowHeights[r];
      ghosts.append(d);
      cur.ghostEls.push(d);
    }
    if (preview.chart) {
      const c = preview.chart.col - box.startCol, r = preview.chart.row - box.startRow;
      const d = el('div', { class: 'g chart' },
        el('div', {}, `${preview.chart.type} chart`), el('strong', {}, preview.chart.title), el('div', { class: 'muted' }, preview.chart.ranges));
      d._x = colX[Math.min(c, colX.length - 1)] ?? 0; d._y = rowY[Math.min(r, rowY.length - 1)] ?? 0; d._w = 600; d._h = 371;
      ghosts.append(d);
      cur.ghostEls.push(d);
    }
  }

  function loop() {
    if (!cur) return;
    const sel = [...document.querySelectorAll('.selection')].find(e => e.getBoundingClientRect().width > 0);
    const nb = window.__byoaDriver.nameBoxValue?.();
    const onSheet = window.__byoaDriver.activeSheet?.() === cur.preview.sheet;
    const aligned = cur.geom && sel && onSheet && nb === cur.geom.range && cur.state === 'pending';
    if (aligned) {
      const r = sel.getBoundingClientRect();
      const gr = gridRect();
      cur.ghosts.style.display = '';
      cur.ghosts.style.clipPath = `inset(${Math.max(0, gr.top + 20)}px ${Math.max(0, innerWidth - gr.right)}px ${Math.max(0, innerHeight - gr.bottom)}px ${Math.max(0, gr.left + 45)}px)`;
      for (const d of cur.ghostEls) {
        d.style.left = `${r.left + d._x}px`; d.style.top = `${r.top + d._y}px`;
        d.style.width = `${d._w}px`; d.style.height = `${d._h}px`;
      }
    } else cur.ghosts.style.display = 'none';
    if (aligned !== cur.aligned) { cur.aligned = aligned; renderCard(); }
    cur.raf = requestAnimationFrame(loop);
  }

  function placeCard() {
    const gr = gridRect();
    cur.card.style.top = `${Math.round(gr.top + 28)}px`;
    cur.card.style.right = `${Math.round(Math.max(16, innerWidth - gr.right + 28))}px`;
  }

  // --- card --------------------------------------------------------------------------
  function renderCard() {
    if (!cur) return;
    const { preview: p, state } = cur;
    const valid = p.ops.filter(o => !o.errors.length).map(o => o.index);
    const dot = { pending: '', applying: '', applied: 'ok', failed: 'bad', stale: 'warn', rejected: 'bad', sent: '' }[state];
    const eyebrow = { pending: 'Proposed change · needs your OK', applying: 'Applying…', applied: 'Applied', failed: 'Failed', stale: 'Out of date', rejected: 'Rejected', sent: 'Sent to agent' }[state];
    const kids = [
      el('div', { class: 'eyebrow' }, state === 'applying' ? el('span', { class: 'spin' }) : el('span', { class: `dot ${dot}` }), eyebrow),
      el('h3', {}, p.title),
      p.rationale ? el('p', {}, p.rationale) : null,
      el('ul', {}, p.ops.map(o => [el('li', {}, o.summary), ...o.errors.map(e => el('li', { class: 'err' }, e)), ...o.warnings.map(w => el('li', { class: 'warnl' }, w))])),
      p.assumptions?.length ? el('details', {}, el('summary', {}, `Assumptions (${p.assumptions.length})`), el('ul', {}, p.assumptions.map(a => el('li', {}, a)))) : null,
    ];
    if (state === 'pending') {
      if (p.box && !cur.aligned && cur.geom) kids.push(el('p', { class: 'muted' }, 'Preview hidden while you look elsewhere. ', el('button', { class: 'link', onclick: () => window.__byoaDriver.run('select', { sheet: p.sheet, range: cur.geom.range }, { restoreView: false }) }, 'Show on sheet')));
      if (cur.geomError) kids.push(el('p', { class: 'muted' }, `Could not draw the preview on the sheet (${cur.geomError}).`));
      if (cur.feedback) {
        const ta = el('textarea', { 'aria-label': 'What should the agent change?', placeholder: 'What should the agent change?' });
        kids.push(ta, el('div', { class: 'row' },
          el('button', { class: 'primary', onclick: () => decide('revise', ta.value) }, 'Send'),
          el('button', { onclick: () => { cur.feedback = false; renderCard(); } }, 'Cancel')));
        setTimeout(() => ta.focus(), 0);
      } else {
        kids.push(el('div', { class: 'row' },
          el('button', { class: 'primary', disabled: !valid.length, onclick: () => accept(valid) }, 'Accept'),
          el('button', { onclick: () => decide('reject') }, 'Reject'),
          el('button', { class: 'link', onclick: () => { cur.feedback = true; renderCard(); } }, 'Revise…')));
      }
    } else if (state === 'stale') {
      kids.push(el('p', {}, 'The sheet changed after this was proposed, so it can no longer be applied. The agent has been told to propose again.'), el('div', { class: 'row' }, el('button', { onclick: () => hide() }, 'Dismiss')));
    } else if (state === 'failed') {
      kids.push(el('p', {}, cur.message ?? 'Something went wrong.'), el('div', { class: 'row' }, el('button', { onclick: () => hide() }, 'Dismiss')));
    } else if (cur.message) kids.push(el('p', { class: 'muted' }, cur.message));
    cur.card.replaceChildren(...kids.filter(Boolean));
  }

  async function accept(indexes) {
    cur.state = 'applying';
    cur.ghosts.replaceChildren();
    cur.ghostEls = [];
    renderCard();
    const planId = cur.preview.planId;
    const r = await send({ type: 'plan:approve', planId, approvedIndexes: indexes }).catch(e => ({ ok: false, error: e.message }));
    if (!cur || cur.preview.planId !== planId) return;
    if (!r?.ok) { cur.state = 'failed'; cur.message = r?.error; renderCard(); return; }
    const st = r.result.status;
    if (st === 'stale') { cur.state = 'stale'; renderCard(); return; }
    if (st === 'executed') { cur.state = 'applied'; cur.message = 'Changes applied and verified.'; renderCard(); await sleep(1800); hide(planId); return; }
    cur.state = 'failed';
    cur.message = st === 'executed_with_issues' ? 'Applied, but verification found issues. See the agent panel for details.' : st === 'partial_failure' ? 'Only part of the change was applied. You can revert it from the agent panel (⋯ → Changes).' : 'The change could not be applied.';
    renderCard();
  }

  async function decide(decision, feedback = '') {
    if (decision === 'revise' && !feedback.trim()) return;
    const planId = cur.preview.planId;
    await send({ type: 'plan:decide', planId, decision, feedback }).catch(() => {});
    if (!cur || cur.preview.planId !== planId) return;
    cur.state = decision === 'revise' ? 'sent' : 'rejected';
    cur.message = decision === 'revise' ? 'Your feedback was sent to the agent.' : 'Nothing was written.';
    cur.ghosts.replaceChildren();
    renderCard();
    await sleep(1600);
    hide(planId);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.channel !== 'preview') return false;
    if (msg.action === 'show') { show(msg.preview).then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: e.message })); return true; }
    if (msg.action === 'hide') hide(msg.planId);
    if (msg.action === 'stale' && cur?.preview.planId === msg.planId && cur.state === 'pending') { cur.state = 'stale'; cur.ghosts.replaceChildren(); renderCard(); }
    sendResponse({ ok: true });
    return false;
  });
  addEventListener('resize', () => cur && placeCard());
})();
