// Page driver: reads and edits the open Google Sheet purely through the page, the way a user
// would — Name Box navigation, clipboard copy/paste events, toolbar/menu clicks (cf. Docs Hotkey).
// No Google APIs, no OAuth: everything runs with the user's own session and permissions.
//
// Reading uses a synthetic `copy` event: Sheets fills the DataTransfer with text/plain (display
// values) and its compact-table JSON (raw values, R1C1 formulas, number formats, styles).
// Writing uses synthetic `paste` events (values/formulas as typed text) and toolbar buttons.
// Revert snapshots are the full clipboard payload of a range, pasted back verbatim.

(() => {
  if (window.__byoaDriver) return;
  window.__byoaDriver = {}; // filled in below; preview.js (same isolated world) uses run()

  const COMPACT = 'application/x-vnd.google-spreadsheet-compact-table+json';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const visible = el => !!el && !!el.offsetParent;

  // --- A1 helpers (classic script; mirrors a1.js) ---------------------------------------
  const colToIndex = col => { let n = 0; for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const indexToCol = i => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const cellA1 = (r, c) => `${indexToCol(c)}${r + 1}`;
  const rangeA1 = (r0, c0, r1, c1) => (r0 === r1 - 1 && c0 === c1 - 1 ? cellA1(r0, c0) : `${cellA1(r0, c0)}:${cellA1(r1 - 1, c1 - 1)}`);
  const parseRef = ref => {
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(ref.replace(/\$/g, ''));
    if (!m) throw new Error(`Bad range ${ref}`);
    const r0 = Number(m[2]) - 1, c0 = colToIndex(m[1]);
    return { r0, c0, r1: m[4] ? Number(m[4]) : r0 + 1, c1: m[3] ? colToIndex(m[3]) + 1 : c0 + 1 };
  };

  // R1C1 (relative, as Sheets puts on the clipboard) → A1 for the cell at (row, col).
  function r1c1ToA1(formula, row, col) {
    return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(
      /(?<![A-Za-z0-9_.])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Za-z0-9_(])/g,
      (all, r, c) => {
        const rr = r === undefined ? { v: row, abs: false } : r.startsWith('[') ? { v: row + Number(r.slice(1, -1)), abs: false } : { v: Number(r) - 1, abs: true };
        const cc = c === undefined ? { v: col, abs: false } : c.startsWith('[') ? { v: col + Number(c.slice(1, -1)), abs: false } : { v: Number(c) - 1, abs: true };
        return `${cc.abs ? '$' : ''}${indexToCol(cc.v)}${rr.abs ? '$' : ''}${rr.v + 1}`;
      }))).join('');
  }

  // --- low-level events -------------------------------------------------------------------
  function key(el, k, code, keyCode, mods = {}) {
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: k, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ...mods }));
  }
  function click(el, { x = 4, y = 4 } = {}) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + x, clientY: r.top + y };
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, opts));
  }
  const nameBox = () => $('#t-name-box');
  const gridInput = () => document.querySelector('#waffle-rich-text-editor') ?? document.activeElement;

  async function select(a1) {
    const nb = nameBox();
    if (!nb) throw new Error('Name Box not found — is this a Google Sheets editor page?');
    nb.focus();
    nb.value = a1;
    nb.dispatchEvent(new Event('input', { bubbles: true }));
    key(nb, 'Enter', 'Enter', 13);
    for (let i = 0; i < 20; i++) {
      await sleep(40);
      if (document.activeElement !== nb) break;
    }
    await sleep(60);
    const dlg = [...document.querySelectorAll('.modal-dialog')].find(d => visible(d) && /problem|invalid/i.test(d.innerText));
    if (dlg) {
      const ok = [...dlg.querySelectorAll('button')].find(b => /^ok$/i.test(b.innerText.trim()));
      if (ok) click(ok);
      await sleep(150);
      throw new Error(`Sheets rejected range "${a1}": ${dlg.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }
  const isA1 = v => /^\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?$/i.test(v ?? '');

  async function copyPayload(a1, { full = false } = {}) {
    await select(a1);
    const dt = new DataTransfer();
    gridInput().dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    if (!full) return { text: dt.getData('text/plain'), compact: dt.getData(COMPACT) };
    const out = {};
    for (const t of dt.types) out[t] = dt.getData(t);
    return out;
  }

  async function pastePayload(a1, payload) {
    await select(a1);
    const dt = new DataTransfer();
    for (const [t, v] of Object.entries(payload)) dt.setData(t, v);
    gridInput().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(350);
    await dismissBlockingDialog();
  }

  // Protected ranges / errors show a modal; treat as failure.
  async function dismissBlockingDialog() {
    const dlg = [...document.querySelectorAll('.modal-dialog, [role="alertdialog"], [role="dialog"]')].find(d => visible(d) && /protected|can't|cannot|unable|error/i.test(d.innerText));
    if (!dlg) return;
    const text = dlg.innerText.trim().split('\n').slice(0, 3).join(' ');
    const btn = [...dlg.querySelectorAll('button, [role="button"]')].find(b => /^(ok|cancel|got it)$/i.test(b.innerText.trim()));
    if (btn) click(btn);
    throw new Error(`Sheets blocked the edit: ${text}`);
  }

  // --- TSV + compact-table decoding ----------------------------------------------------
  function parseTSV(text) {
    const rows = [[]];
    let cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch;
      } else if (ch === '"' && cur === '') inQ = true;
      else if (ch === '\t') { rows.at(-1).push(cur); cur = ''; }
      else if (ch === '\n') { rows.at(-1).push(cur); rows.push([]); cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    rows.at(-1).push(cur);
    return rows;
  }

  const rle = arr => { const out = []; for (let i = 0; i < (arr ?? []).length; i++) { if (arr[i] < 0) { const n = -arr[i]; const v = arr[++i]; for (let k = 0; k < n; k++) out.push(v); } else out.push(arr[i]); } return out; };
  const FMT_TYPES = { 1: 'TEXT', 2: 'NUMBER', 3: 'PERCENT', 4: 'CURRENCY', 5: 'DATE', 6: 'TIME', 7: 'DATE_TIME', 8: 'SCIENTIFIC' };
  const intToHex = n => `#${n.toString(16).padStart(6, '0')}`;

  function decode(text, compactJson, r0, c0) {
    const display = parseTSV(text ?? '');
    let j;
    try { j = JSON.parse(compactJson); } catch { j = null; }
    const rows = j?.['15']?.['1'] ?? display.length;
    const cols = j?.['15']?.['2'] ?? Math.max(...display.map(r => r.length));
    const kinds = rle(j?.['2']);
    const vtypes = j?.['3']?.['1'] ?? [];
    const nums = j?.['3']?.['3'] ?? [], strs = j?.['3']?.['4'] ?? [], specials = j?.['3']?.['5'] ?? [];
    const formulas = j?.['8'] ?? [], fidx = rle(j?.['9']);
    const styles = j?.['4'] ?? [], styleIdx = rle(j?.['5']);
    let vi = 0, ni = 0, si = 0, xi = 0, fi = 0;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const kind = kinds.length ? kinds[idx] : 195;
        const t = display[r]?.[c] ?? '';
        const cell = { v: null, f: null, t, fmt: null, err: null, style: null };
        if (kind & 1) {
          const ty = vtypes[vi++];
          if (ty === 1) cell.v = nums[ni++];
          else if (ty === 2) cell.v = strs[si++];
          else if (ty === 3) {
            const sp = specials[xi++] ?? {};
            if (sp['1'] === 4) cell.v = !!sp['4'];
            else { cell.err = t.startsWith('#') ? t.replace(/[!?]$/, '').replace(/^#/, '') : 'ERROR'; }
          }
        }
        if (kind & 8) cell.f = r1c1ToA1(formulas[fidx[fi++]] ?? '', r0 + r, c0 + c);
        const st = styles[styleIdx[idx]];
        if (st) {
          if (st['3']) cell.fmt = { type: FMT_TYPES[st['3']['1']] ?? 'NUMBER', pattern: st['3']['2'] ?? '' };
          cell.style = { bold: st['17'] === 1, italic: st['18'] === 1, background: st['4']?.['2'] !== undefined ? intToHex(st['4']['2']) : null };
        }
        row.push(cell);
      }
      cells.push(row);
    }
    return cells;
  }

  // --- sheet/tab navigation ------------------------------------------------------------
  const gids = {};
  const tabEls = () => [...document.querySelectorAll('.docs-sheet-tab')];
  const tabName = el => (el.querySelector('.docs-sheet-tab-name')?.innerText ?? el.innerText).trim();
  const activeSheet = () => { const el = $('.docs-sheet-active-tab'); return el ? tabName(el) : null; };
  const currentGid = () => { const m = /gid=(\d+)/.exec(location.hash + location.search); return m ? Number(m[1]) : null; };

  async function switchTo(title) {
    if (!title || activeSheet() === title) { gids[activeSheet()] ??= currentGid(); return; }
    const el = tabEls().find(t => tabName(t) === title);
    if (!el) throw new Error(`Sheet "${title}" not found. Tabs: ${tabEls().map(tabName).join(', ')}`);
    click(el.querySelector('.docs-sheet-tab-name') ?? el);
    for (let i = 0; i < 40 && activeSheet() !== title; i++) await sleep(50);
    if (activeSheet() !== title) throw new Error(`Could not switch to sheet "${title}"`);
    await sleep(150);
    gids[title] = currentGid();
  }

  function meta() {
    gids[activeSheet()] ??= currentGid();
    return {
      title: ($('.docs-title-input')?.value || document.title.replace(/ - Google Sheets$/, '')).trim(),
      tabs: tabEls().map(tabName),
      active: activeSheet(),
      gids: { ...gids },
      // The editing toolbar (undo/number formats) is only rendered for users who can edit.
      canEdit: !!document.querySelector('[aria-label^="Undo"]') && !!document.querySelector('[aria-label^="Format as currency"]'),
      ready: !!nameBox(),
    };
  }

  // --- reads ------------------------------------------------------------------------
  async function readRange(sheet, a1) {
    await switchTo(sheet);
    const { r0, c0 } = parseRef(a1);
    const { text, compact } = await copyPayload(a1);
    return { startRow: r0, startCol: c0, cells: decode(text, compact, r0, c0) };
  }

  // Used range: read a generous block and trim trailing empty rows/columns.
  async function readUsed(sheet) {
    let rows = 300, cols = 26, res;
    for (;;) {
      res = await readRange(sheet, rangeA1(0, 0, rows, cols));
      const isEmpty = c => c.v === null && !c.f && !c.err;
      const lastRow = res.cells.findLastIndex(r => r.some(c => !isEmpty(c)));
      const lastCol = Math.max(-1, ...res.cells.map(r => r.findLastIndex(c => !isEmpty(c))));
      if ((lastRow === rows - 1 && rows < 1000) || (lastCol === cols - 1 && cols < 52)) { rows = Math.min(1000, rows * 2); cols = Math.min(52, cols * 2); continue; }
      res.cells = res.cells.slice(0, lastRow + 1).map(r => r.slice(0, lastCol + 1));
      break;
    }
    return { sheetTitle: sheet ?? activeSheet(), sheetId: gids[sheet ?? activeSheet()] ?? null, ...res };
  }

  // --- writes -----------------------------------------------------------------------
  const tsvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  // Writes a rectangular block as typed text (values parse like typing; "=…" become formulas).
  async function pasteBlock(sheet, a1, rows) {
    await switchTo(sheet);
    await pastePayload(a1, { 'text/plain': rows.map(r => r.map(tsvCell).join('\t')).join('\n') });
  }

  async function clearRange(sheet, a1) {
    await switchTo(sheet);
    await select(a1);
    key(gridInput(), 'Delete', 'Delete', 46);
    await sleep(200);
  }

  function toolbarButton(label) {
    const el = document.querySelector(`[aria-label^="${label}"]`);
    if (!el) throw new Error(`Toolbar button "${label}" not found (view-only access, or the toolbar is collapsed).`);
    return el;
  }

  async function clickMenuItem(textRe) {
    const item = [...document.querySelectorAll('.goog-menuitem, [role="menuitem"], [role="menuitemcheckbox"], [role="option"]')].find(e => visible(e) && textRe.test(e.innerText.trim().split('\n')[0]));
    if (!item) { key(document.activeElement, 'Escape', 'Escape', 27); throw new Error(`Menu item ${textRe} not found`); }
    click(item, { x: 10, y: 6 });
    await sleep(250);
  }

  async function numberFormat(sheet, a1, kind, decimals) {
    await switchTo(sheet);
    await select(a1);
    if (kind === 'currency') click(toolbarButton('Format as currency'));
    else if (kind === 'percent') click(toolbarButton('Format as percent'));
    else {
      click(toolbarButton('More formats'));
      await sleep(300);
      await clickMenuItem({ number: /^Number$/, date: /^Date$/, plain: /^Plain text$/ }[kind] ?? /^Number$/);
    }
    await sleep(250);
    // Toolbar currency/percent/number default to 2 decimals; adjust if asked.
    if (decimals !== undefined && decimals !== null && kind !== 'date' && kind !== 'plain') {
      const base = kind === 'percent' ? 2 : 2;
      const diff = decimals - base;
      for (let i = 0; i < Math.abs(diff); i++) { click(toolbarButton(diff > 0 ? 'Increase decimal places' : 'Decrease decimal places')); await sleep(150); }
    }
  }

  async function setTextStyle(sheet, a1, prop, want) {
    await switchTo(sheet);
    const { r0, c0 } = parseRef(a1);
    const current = await readRange(sheet, a1);
    const all = current.cells.flat();
    if (all.every(c => (c.style?.[prop] ?? false) === want)) return;
    await select(a1);
    const btn = toolbarButton(prop === 'bold' ? 'Bold' : 'Italic');
    click(btn);
    await sleep(250);
    // Toggle semantics follow the first cell; click again if the result is still wrong.
    const after = await readRange(sheet, a1);
    if (!after.cells.flat().every(c => (c.style?.[prop] ?? false) === want)) { await select(a1); click(btn); await sleep(250); }
    void r0; void c0;
  }

  async function fillColor(sheet, a1, paletteName) {
    await switchTo(sheet);
    await select(a1);
    click(toolbarButton('Fill color'));
    const sw = await waitFor(() => [...document.querySelectorAll('.docs-material-colorpalette-colorswatch')].find(e => visible(e) && (e.title === paletteName || e.parentElement?.getAttribute('aria-label') === paletteName)), 2500);
    if (!sw) { key(document.activeElement, 'Escape', 'Escape', 27); throw new Error(`Palette color "${paletteName}" not found`); }
    click(sw.parentElement?.getAttribute('role') === 'gridcell' ? sw.parentElement : sw);
    await sleep(250);
  }

  async function addSheet(title) {
    const before = tabEls().map(tabName);
    if (before.includes(title)) throw new Error(`Sheet "${title}" already exists`);
    click(toolbarButtonOrTab('Add Sheet'));
    for (let i = 0; i < 40 && tabEls().length === before.length; i++) await sleep(50);
    await sleep(300);
    const nameEl = $('.docs-sheet-active-tab .docs-sheet-tab-name');
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    await sleep(300);
    const ed = document.activeElement;
    if (!ed?.isContentEditable) throw new Error('Could not rename the new sheet');
    ed.textContent = title;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    key(ed, 'Enter', 'Enter', 13);
    await sleep(500);
    if (activeSheet() !== title) throw new Error(`New sheet was not renamed to "${title}"`);
    gids[title] = currentGid();
    return { title, gid: gids[title] };
  }
  const toolbarButtonOrTab = label => document.querySelector(`[aria-label="${label}"]`) ?? (() => { throw new Error(`"${label}" button not found`); })();

  async function deleteSheet(title) {
    await switchTo(title);
    const tab = $('.docs-sheet-active-tab');
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }));
    await sleep(350);
    await clickMenuItem(/^Delete$/);
    await sleep(400);
    const dlg = [...document.querySelectorAll('.modal-dialog, [role="dialog"], [role="alertdialog"]')].find(visible);
    const ok = dlg && [...dlg.querySelectorAll('button')].find(b => /^ok$/i.test(b.innerText.trim()));
    if (ok) click(ok);
    for (let i = 0; i < 40 && tabEls().some(t => tabName(t) === title); i++) await sleep(50);
    if (tabEls().some(t => tabName(t) === title)) throw new Error(`Could not delete sheet "${title}"`);
  }

  const chartOverlays = () => [...document.querySelectorAll('.waffle-borderless-embedded-object-overlay')].filter(e => e.querySelector('.waffle-objwrap-gvizchart'));
  const chartKey = el => ({ label: (el.getAttribute('aria-label') ?? '').replace(/\s+Press Ctrl.*$/, '').trim(), top: el.style.top, left: el.style.left });

  // Pixel geometry of the grid (from Sheets' own clipboard HTML: <col width>, <tr height>).
  async function gridOffset(row, col) {
    let left = 0, top = 0;
    if (col > 0) {
      const { html } = await copyHtml(rangeA1(0, 0, 1, col));
      left = [...html.matchAll(/<col width="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
    }
    if (row > 0) {
      const { html } = await copyHtml(rangeA1(0, 0, row, 1));
      top = [...html.matchAll(/<tr style="height:(\d+)px/g)].reduce((a, m) => a + Number(m[1]), 0);
    }
    return { left, top };
  }
  async function copyHtml(a1) {
    await select(a1);
    const dt = new DataTransfer();
    gridInput().dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { html: dt.getData('text/html') };
  }

  // Charts only drag once selected: click to select, then press-move-release.
  async function drag(el, dx, dy) {
    const fire = (node, type, x, y, buttons = 1) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons, clientX: x, clientY: y }));
    let t = el.querySelector('.waffle-objwrap-gvizchart') ?? el;
    let r = t.getBoundingClientRect();
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) fire(t, type, r.left + 40, r.top + 40, type === 'mousedown' ? 1 : 0);
    const focused = await waitFor(() => chartOverlays().find(o => o.classList.contains('waffle-borderless-embedded-object-overlay-focused')), 1500);
    if (!focused) return;
    el = focused;
    t = el.querySelector('.waffle-objwrap-gvizchart') ?? el;
    r = t.getBoundingClientRect();
    const sx = r.left + 40, sy = r.top + 40;
    fire(t, 'mousedown', sx, sy);
    for (let i = 1; i <= 10; i++) {
      const x = sx + (dx * i) / 10, y = sy + (dy * i) / 10;
      fire(t, 'mousemove', x, y);
      fire(document, 'mousemove', x, y);
      await sleep(30);
    }
    fire(document, 'mouseup', sx + dx, sy + dy, 0);
    await sleep(600);
  }

  async function closeSidebar() {
    const close = [...document.querySelectorAll('.docs-sidebar-gm-titlebar-icon-button')].find(visible);
    if (close) { click(close); await sleep(300); }
  }

  async function insertChart(sheet, ranges, type, anchor, title) {
    await switchTo(sheet);
    const before = new Set(chartOverlays());
    const first = ranges.split(',')[0].split(':')[0];
    await select(first);
    click(toolbarButtonOrTab('Insert chart'));
    let el, placementWarning = null;
    for (let i = 0; i < 60 && !el; i++) { await sleep(100); el = chartOverlays().find(o => !before.has(o)); }
    if (!el) throw new Error('Chart was not created');
    try {
      // Data range: Sheets guesses from the selection; set exactly what was approved.
      const inp = await waitFor(() => [...document.querySelectorAll('.waffle-sidebar-container input')].find(visible), 3000);
      if (!inp) throw new Error('Chart editor did not open');
      if (inp.value !== ranges) {
        inp.focus();
        inp.value = ranges;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        key(inp, 'Enter', 'Enter', 13);
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(900);
      }
      const usedRange = [...document.querySelectorAll('.waffle-sidebar-container input')].find(visible)?.value;
      if (usedRange !== ranges) throw new Error(`Chart data range is ${usedRange}, expected ${ranges}`);
      const label = { LINE: 'Line chart', COLUMN: 'Column chart', BAR: 'Bar chart' }[type];
      const sel = await waitFor(() => document.querySelector('.docs-charts-editor-chart-type-select'), 3000);
      if (sel && label && sel.getAttribute('aria-label') !== `Chart Type: ${label}`) {
        click(sel);
        const opt = await waitFor(() => [...document.querySelectorAll('.docs-charts-editor-charttype-option')].find(o => visible(o) && o.getAttribute('aria-label') === label), 2000);
        if (!opt) throw new Error(`Chart type "${label}" not offered by Sheets for this data`);
        click(opt);
        await sleep(600);
      }
      const finalType = document.querySelector('.docs-charts-editor-chart-type-select')?.getAttribute('aria-label')?.replace('Chart Type: ', '') ?? null;
      // Title: Sheets' auto-title reflects its first range guess, so always set the approved one.
      if (title) {
        const cust = [...document.querySelectorAll('.waffle-sidebar-container [role="tab"]')].find(e => visible(e) && /customi/i.test(e.innerText));
        if (cust) { click(cust); await sleep(500); }
        const hdr = await waitFor(() => [...document.querySelectorAll('.docs-charts-editor-collapsible-header')].find(e => visible(e) && /Chart & axis titles/.test(e.innerText)), 2000);
        if (hdr && hdr.getAttribute('aria-expanded') !== 'true') { click(hdr); await sleep(400); }
        const ta = await waitFor(() => [...document.querySelectorAll('.waffle-sidebar-container textarea[aria-label="Chart title"]')].find(visible), 2000);
        if (!ta) throw new Error('Chart title field not found');
        ta.focus();
        ta.value = title;
        for (const t of ['input', 'change', 'blur']) ta.dispatchEvent(new Event(t, { bubbles: true }));
        ta.blur();
        await sleep(700);
      }
      await closeSidebar();
      key(document.activeElement, 'Escape', 'Escape', 27);
      // Sheets re-renders the chart element when its spec changes; re-find it.
      el = chartOverlays().find(o => !before.has(o)) ?? el;
      // Move the chart so its top-left sits in the anchor cell.
      if (anchor) {
        const want = await gridOffset(anchor.row, anchor.col);
        for (let attempt = 0; attempt < 3; attempt++) {
          const dx = want.left + 6 - parseFloat(el.style.left), dy = want.top + 6 - parseFloat(el.style.top);
          if (Math.abs(dx) < 40 && Math.abs(dy) < 25) break;
          await drag(el, dx, dy);
          el = chartOverlays().find(o => !before.has(o)) ?? el;
        }
        const finalDx = Math.abs(want.left + 6 - parseFloat(el.style.left)), finalDy = Math.abs(want.top + 6 - parseFloat(el.style.top));
        if (finalDx >= 40 || finalDy >= 25) placementWarning = `Chart could not be moved to the anchor cell (placed at ${el.style.left}, ${el.style.top})`;
        key(document.activeElement, 'Escape', 'Escape', 27);
      }
      await select(first);
      return { key: chartKey(el), type: finalType, range: usedRange, warning: placementWarning };
    } catch (e) {
      // Leave no half-configured chart behind.
      await closeSidebar().catch(() => {});
      try { await selectAndDeleteChart(el); } catch (cleanupErr) { e.message += ` (and the new chart could not be removed: ${cleanupErr.message})`; }
      throw e;
    }
  }

  // Select a chart and press Delete — only if Sheets confirms the chart (not a cell) is selected,
  // otherwise Delete would clear the active cell.
  async function selectAndDeleteChart(el) {
    key(document.activeElement, 'Escape', 'Escape', 27);
    click(el.querySelector('.waffle-objwrap-gvizchart') ?? el, { x: 40, y: 40 });
    // Sheets may re-render the overlay on selection; accept the focused overlay with the same title.
    const k = chartKey(el);
    const focused = await waitFor(() => chartOverlays().find(o => o.classList.contains('waffle-borderless-embedded-object-overlay-focused') && chartKey(o).label === k.label), 1500);
    if (!focused) throw new Error('Could not select the chart; not deleting anything.');
    const countBefore = chartOverlays().length;
    key(document.activeElement, 'Delete', 'Delete', 46);
    for (let i = 0; i < 20 && chartOverlays().length >= countBefore; i++) await sleep(50);
    if (chartOverlays().length >= countBefore) throw new Error('Chart could not be deleted');
    key(document.activeElement, 'Escape', 'Escape', 27);
  }

  async function deleteChart(sheet, k) {
    await switchTo(sheet);
    // Match by title (unique), else by position — the user may have moved the chart since.
    const byLabel = chartOverlays().filter(o => chartKey(o).label === k.label);
    const byPos = chartOverlays().filter(o => { const c = chartKey(o); return c.top === k.top && c.left === k.left; });
    const el = byLabel.length === 1 ? byLabel[0] : byLabel.find(o => byPos.includes(o)) ?? (byPos.length === 1 ? byPos[0] : null);
    if (!el) throw new Error('Chart not found (it may have been moved or deleted)');
    await selectAndDeleteChart(el);
  }

  async function waitFor(fn, ms) {
    for (let t = 0; t < ms; t += 50) { const v = fn(); if (v) return v; await sleep(50); }
    return null;
  }

  // --- busy banner + user selection restore ----------------------------------------
  let banner;
  function showBanner(text) {
    banner ??= Object.assign(document.createElement('div'), { role: 'status' });
    banner.textContent = text;
    Object.assign(banner.style, { position: 'fixed', top: '8px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647, background: '#0f624a', color: '#fff', font: '600 13px system-ui, sans-serif', padding: '8px 14px', borderRadius: '8px', boxShadow: '0 2px 10px rgba(0,0,0,.25)', pointerEvents: 'none' });
    document.documentElement.append(banner);
  }
  const hideBanner = () => banner?.remove();

  // Geometry for the on-sheet preview: pixel sizes of the box's columns/rows, then leave the
  // box selected so Sheets' own .selection element marks where it is on screen.
  async function previewGeometry(sheet, box) {
    await switchTo(sheet);
    const { html } = await copyHtml(rangeA1(box.startRow, box.startCol, box.endRow, box.endCol));
    const colWidths = [...html.matchAll(/<col width="(\d+)"/g)].map(m => Number(m[1]));
    const rowHeights = [...html.matchAll(/<tr style="height:(\d+)px/g)].map(m => Number(m[1]));
    const range = rangeA1(box.startRow, box.startCol, box.endRow, box.endCol);
    await select(range);
    return { colWidths, rowHeights, range };
  }

  const OPS = {
    meta: async () => meta(),
    previewGeometry: ({ sheet, box }) => previewGeometry(sheet, box),
    select: ({ sheet, range }) => switchTo(sheet).then(() => select(range)),
    readUsed: ({ sheet }) => readUsed(sheet),
    readRange: ({ sheet, range }) => readRange(sheet, range),
    snapshot: async ({ sheet, range }) => { await switchTo(sheet); return copyPayload(range, { full: true }); },
    restore: async ({ sheet, range, payload }) => { await switchTo(sheet); await pastePayload(range, payload); },
    pasteBlock: ({ sheet, range, rows }) => pasteBlock(sheet, range, rows),
    clearRange: ({ sheet, range }) => clearRange(sheet, range),
    numberFormat: ({ sheet, range, kind, decimals }) => numberFormat(sheet, range, kind, decimals),
    textStyle: ({ sheet, range, prop, value }) => setTextStyle(sheet, range, prop, value),
    fillColor: ({ sheet, range, palette }) => fillColor(sheet, range, palette),
    addSheet: ({ title }) => addSheet(title),
    deleteSheet: ({ title }) => deleteSheet(title),
    insertChart: ({ sheet, ranges, type, anchor, title }) => insertChart(sheet, ranges, type, anchor, title),
    deleteChart: ({ sheet, key: k }) => deleteChart(sheet, k),
  };
  const WRITES = new Set(['restore', 'pasteBlock', 'clearRange', 'numberFormat', 'textStyle', 'fillColor', 'addSheet', 'deleteSheet', 'insertChart', 'deleteChart']);

  // Serialize: one page interaction at a time, then put the user back where they were.
  let queue = Promise.resolve();
  function run(op, args, { restoreView = true } = {}) {
    const job = queue.then(async () => {
      const fn = OPS[op];
      if (!fn) throw new Error(`Unknown driver op ${op}`);
      const origSheet = activeSheet();
      const origSel = nameBox()?.value;
      if (WRITES.has(op)) showBanner('Applying approved changes…');
      try {
        return await fn(args ?? {});
      } finally {
        if (WRITES.has(op)) hideBanner();
        if (restoreView && origSheet && op !== 'addSheet') {
          try {
            if (activeSheet() !== origSheet && tabEls().some(t => tabName(t) === origSheet)) await switchTo(origSheet);
            if (isA1(origSel) && activeSheet() === origSheet) await select(origSel);
          } catch { /* best effort */ }
        }
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  Object.assign(window.__byoaDriver, { run, nameBoxValue: () => nameBox()?.value ?? null, activeSheet });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.channel !== 'driver') return false;
    run(msg.op, msg.args, msg.options).then(
      result => sendResponse({ ok: true, result }),
      e => sendResponse({ ok: false, error: e?.message ?? String(e) }),
    );
    return true;
  });
})();
