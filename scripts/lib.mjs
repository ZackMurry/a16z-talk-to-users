// Shared test-harness helpers.
import puppeteer from 'puppeteer-core';
export const EXT = 'pkdmhhbbnnpfjhficmplghheabhhcjnh';
export const connect = () => puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });

// Opens an extension page in its own minimized window so the spreadsheet tab stays visible
// (hidden tabs get their timers throttled, which slows page interaction ~10x).
export async function extPage(b, path = 'panel/blank.html') {
  const session = await b.target().createCDPSession();
  const { targetId } = await session.send('Target.createTarget', { url: `chrome-extension://${EXT}/${path}`, newWindow: true, background: true, windowState: 'minimized' });
  const t = await b.waitForTarget(t => t._targetId === targetId || t.targetId?.() === targetId);
  const p = await t.page();
  await p.waitForFunction(() => document.readyState === 'complete');
  return p;
}
