// Sends a side-panel action to the service worker (what the panel buttons do).
// usage: node scripts/panel.mjs <type> ['{"json":"payload"}']
import { connect, extPage } from './lib.mjs';
const [type, json = '{}'] = process.argv.slice(2);
const b = await connect();
const p = await extPage(b);
const out = await p.evaluate((type, payload) => chrome.runtime.sendMessage({ channel: 'panel', type, ...payload }), type, JSON.parse(json));
console.log(JSON.stringify(out, null, 1));
await p.close();
await b.disconnect();
