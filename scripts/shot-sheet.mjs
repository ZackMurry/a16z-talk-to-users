import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const p = (await b.pages()).find(x => x.url().includes('/spreadsheets/d/'));
await p.bringToFront();
await p.screenshot({ path: `.shots/${process.argv[2] ?? 'sheet'}.png` });
await b.disconnect();
