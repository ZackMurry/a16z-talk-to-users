// Plays the user's agent: calls a WebMCP tool on the open spreadsheet page via document.modelContext.
// usage: node scripts/agent.mjs <tool> ['{"json":"args"}']
import puppeteer from 'puppeteer-core';
const [tool, json = '{}'] = process.argv.slice(2);
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const p = (await b.pages()).find(x => /docs\.google\.com\/spreadsheets\/d\//.test(x.url()));
if (!p) { console.error('no spreadsheet tab'); process.exit(1); }
const out = await p.evaluate(async (tool, args) => {
  const tools = await document.modelContext.getTools();
  const t = tools.find(t => t.name === tool);
  if (!t) return { error: `tool ${tool} not registered; have: ${tools.map(t => t.name).join(',')}` };
  const raw = await document.modelContext.executeTool(t, args);
  const res = JSON.parse(raw);
  try { return { isError: !!res.isError, data: JSON.parse(res.content[0].text) }; } catch { return res; }
}, tool, JSON.parse(json));
console.log(JSON.stringify(out, null, 1));
await b.disconnect();
