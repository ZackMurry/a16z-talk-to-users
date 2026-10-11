// Evaluates an expression in an extension page (storage inspection etc.).
import { connect, extPage } from './lib.mjs';
const b = await connect();
const p = await extPage(b);
console.log(JSON.stringify(await p.evaluate(process.argv[2]), null, 1));
await p.close(); await b.disconnect();
