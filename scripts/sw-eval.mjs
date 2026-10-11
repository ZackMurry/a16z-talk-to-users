// Evaluates an expression inside the extension service worker (debug helper).
import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const t = (await b.targets()).find(t => t.type() === 'service_worker' && t.url().includes('pkdmhhbbnnpfjhficmplghheabhhcjnh'));
if (!t) { console.error('service worker not running'); process.exit(1); }
const w = await t.worker();
console.log(JSON.stringify(await w.evaluate(process.argv[2]), null, 1));
await b.disconnect();
