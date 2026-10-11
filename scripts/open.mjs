import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
for (const p of await b.pages()) if (p.url().includes('/spreadsheets/')) await p.close();
const p = await b.newPage();
await p.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 7000));
console.log(await p.title());
await b.disconnect();
