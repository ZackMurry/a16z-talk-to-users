// Launches Chrome for Testing with the WebMCP flag, a persistent dev profile,
// the unpacked extension, and a remote-debugging port for test scripts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chromeDir = path.join(root, '.chrome/chrome');
const build = fs.readdirSync(chromeDir).sort().at(-1);
const chrome = path.join(chromeDir, build, 'chrome-linux64/chrome');
const profile = path.join(root, '.profile');
fs.mkdirSync(profile, { recursive: true });

// Enable chrome://flags/#enable-webmcp-testing via Local State.
const localStatePath = path.join(profile, 'Local State');
const state = fs.existsSync(localStatePath) ? JSON.parse(fs.readFileSync(localStatePath, 'utf8')) : {};
state.browser ??= {};
const labs = new Set(state.browser.enabled_labs_experiments ?? []);
labs.add('enable-webmcp-testing@1');
state.browser.enabled_labs_experiments = [...labs];
fs.writeFileSync(localStatePath, JSON.stringify(state));

const port = process.env.CDP_PORT ?? '9222';
const args = [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  `--load-extension=${path.join(root, 'extension')}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...process.argv.slice(2),
];
const child = spawn(chrome, args, { stdio: 'ignore', detached: true });
child.unref();
console.log(`Chrome ${build} pid=${child.pid} cdp=http://127.0.0.1:${port}`);
