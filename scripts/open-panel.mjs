// Opens the extension side panel for the current window using a trusted (CDP) click as the user gesture.
import { connect, EXT } from './lib.mjs';
const b = await connect();
const sheet = (await b.pages()).find(p => p.url().includes('/spreadsheets/d/'));
const helper = await b.newPage();
await helper.goto(`chrome-extension://${EXT}/panel/blank.html`);
await helper.evaluate(() => {
  document.body.innerHTML = '<button id="o" style="width:300px;height:100px">open</button>';
  document.getElementById('o').addEventListener('click', async () => {
    const w = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: w.id });
    window.__opened = true;
  });
});
await helper.click('#o');
await new Promise(r => setTimeout(r, 800));
console.log('opened:', await helper.evaluate(() => window.__opened ?? false));
await helper.close();
await sheet.bringToFront();
await new Promise(r => setTimeout(r, 1500));
const panel = (await b.targets()).filter(t => t.url().includes('panel/panel.html')).map(t => t.type());
console.log('panel targets:', panel);
await b.disconnect();
