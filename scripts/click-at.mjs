// Trusted mouse click at viewport coordinates in the spreadsheet tab (for shadow-DOM UI).
import { connect } from './lib.mjs';
const [x, y] = process.argv.slice(2).map(Number);
const b = await connect();
const p = (await b.pages()).find(p => p.url().includes('/spreadsheets/d/'));
await p.mouse.click(x, y);
await b.disconnect();
