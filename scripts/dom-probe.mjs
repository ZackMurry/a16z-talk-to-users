import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const p = (await b.pages()).find(x => x.url().includes('/spreadsheets/d/'));
const code = fs.readFileSync(process.argv[2], 'utf8');
console.log(JSON.stringify(await p.evaluate(`(async () => { ${code} })()`), null, 1));
await b.disconnect();
