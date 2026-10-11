// Isolated-world relay between the MAIN-world WebMCP registrar (webmcp.js) and the service worker.
(() => {
  const TAG = '__byoa';
  let tools = null;
  let enabled = true;

  const post = msg => window.postMessage({ [TAG]: 'to-page', ...msg }, location.origin);

  async function init() {
    try {
      const res = await chrome.runtime.sendMessage({ channel: 'panel', type: 'tools:defs' });
      tools = res?.result ?? [];
      const { agent } = await chrome.storage.local.get('agent');
      enabled = agent?.enabled !== false;
      post({ kind: 'init', tools, enabled });
    } catch (e) {
      // Extension reloaded/unavailable: the page keeps working, tools are simply not offered.
      post({ kind: 'init', tools: [], enabled: false, error: String(e?.message ?? e) });
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.agent) return;
    const next = changes.agent.newValue?.enabled !== false;
    if (next !== enabled) { enabled = next; post({ kind: 'enabled', enabled }); }
  });

  window.addEventListener('message', async e => {
    if (e.source !== window || e.data?.[TAG] !== 'to-ext') return;
    const m = e.data;
    if (m.kind === 'ready') { if (tools) post({ kind: 'init', tools, enabled }); else init(); return; }
    if (m.kind === 'status') { chrome.runtime.sendMessage({ channel: 'tab-status', status: m.status }).catch(() => {}); return; }
    if (m.kind === 'call') {
      let response;
      try {
        response = await chrome.runtime.sendMessage({ channel: 'tool', name: m.name, args: m.args, poll: !!m.poll, url: location.href });
      } catch (err) {
        response = { ok: false, error: `Extension unavailable: ${err?.message ?? err}`, actionable: 'Reload the spreadsheet tab (the extension may have been updated).' };
      }
      post({ kind: 'result', id: m.id, response });
    }
  });

  init();
})();
