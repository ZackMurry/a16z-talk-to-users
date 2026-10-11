// Types a message into the side-panel agent and sends it (as the user would).
import { connect } from './lib.mjs';
const text = process.argv[2];
const b = await connect();
const t = (await b.targets()).find(t => t.url().endsWith('panel/panel.html') || t.url().includes('panel/panel.html?'));
const p = await t.page();
await p.click('#input');
await p.type('#input', text);
await p.keyboard.press('Enter');
await b.disconnect();
