// Dev helper: reloads the unpacked extension, then reloads all open spreadsheet tabs.
import puppeteer from 'puppeteer-core';
const EXT = 'pkdmhhbbnnpfjhficmplghheabhhcjnh';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const p = await b.newPage();
await p.goto(`chrome-extension://${EXT}/panel/blank.html`);
await p.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); }).catch(() => {});
await new Promise(r => setTimeout(r, 1500));
await p.close().catch(() => {});
for (const s of (await b.pages()).filter(x => x.url().includes('/spreadsheets/d/'))) await s.reload({ waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 8000));
await b.disconnect();
console.log('reloaded');
