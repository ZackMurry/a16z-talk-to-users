// Opens a spreadsheet and lists the WebMCP tools registered on the page.
import puppeteer from 'puppeteer-core';
const url = process.argv[2] ?? 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const p = await b.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 4000));
const tools = await p.evaluate(async () => (await document.modelContext.getTools()).map(t => `${t.name} [${t.annotations.readOnlyHint ? 'ro' : 'rw'}${t.annotations.untrustedContentHint ? ',untrusted' : ''}]`));
console.log(tools.length, 'tools:', tools.join(', '));
const res = await p.evaluate(async () => { const t = (await document.modelContext.getTools()).find(t => t.name === 'get_workspace_info'); return document.modelContext.executeTool(t, { agent_name: 'probe' }); });
console.log('get_workspace_info ->', res.slice(0, 400));
await b.disconnect();
