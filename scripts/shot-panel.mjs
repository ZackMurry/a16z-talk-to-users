// Opens the side panel page pinned to the spreadsheet tab, switches to a section and screenshots it.
// usage: node scripts/shot-panel.mjs <tab> [name]
import { connect, extPage, EXT } from './lib.mjs';
const [tab = 'agent', name = tab] = process.argv.slice(2);
const b = await connect();
const p = await extPage(b);
await p.setViewport({ width: 400, height: 1000 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
const sheetTabId = await p.evaluate(async () => (await chrome.tabs.query({ url: 'https://docs.google.com/spreadsheets/d/*' }))[0]?.id);
await p.goto(`chrome-extension://${EXT}/panel/panel.html?tabId=${sheetTabId}`);
await new Promise(r => setTimeout(r, 2500));
await p.click(`button[data-tab="${tab}"]`);
await new Promise(r => setTimeout(r, 1200));
await p.screenshot({ path: `.shots/panel-${name}.png`, fullPage: true });
if (errs.length) console.log('errors:', errs);
await p.close();
await b.disconnect();
