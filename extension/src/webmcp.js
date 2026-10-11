// MAIN-world WebMCP registrar. Registers the extension's tools on document.modelContext so the
// user's own browser agent can call them. All work happens in the extension; this file only relays.
(() => {
  const TAG = '__byoa';
  const POLLING = { get_plan_status: r => !['pending_approval', 'executing'].includes(r?.status), get_approved_summary: r => r?.available === true };
  let controller = null;
  let pending = new Map();
  let seq = 0;
  let toolDefs = [];

  const mc = () => document.modelContext ?? navigator.modelContext ?? null;
  const send = msg => window.postMessage({ [TAG]: 'to-ext', ...msg }, location.origin);
  const status = s => send({ kind: 'status', status: s });

  function call(name, args, poll = false) {
    const id = `${Date.now()}-${++seq}`;
    return new Promise(resolve => {
      pending.set(id, resolve);
      send({ kind: 'call', id, name, args, poll });
    });
  }

  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  async function runTool(name, args, signal) {
    const wait = Math.min(120, Math.max(0, Number(args?.wait_seconds ?? 0)));
    const { wait_seconds, ...rest } = args ?? {};
    let res = await call(name, rest);
    const done = POLLING[name];
    if (done && wait && res.ok && !done(res.result)) {
      const deadline = Date.now() + wait * 1000;
      while (Date.now() < deadline && res.ok && !done(res.result)) {
        await sleep(1500, signal);
        res = await call(name, rest, true);
      }
    }
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: res.error, actionable: res.actionable }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.result) }] };
  }

  async function register() {
    const ctx = mc();
    if (!ctx?.registerTool) {
      status({ webmcp: 'unavailable', registered: 0, reason: 'document.modelContext is not available. Use Chrome 146+ with chrome://flags/#enable-webmcp-testing enabled (or an origin-trial build).' });
      return;
    }
    unregister();
    controller = new AbortController();
    const names = [];
    const errors = [];
    for (const t of toolDefs) {
      try {
        await ctx.registerTool({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations,
          execute: (args, opts) => runTool(t.name, args, opts?.signal),
        }, { signal: controller.signal });
        names.push(t.name);
      } catch (e) {
        errors.push(`${t.name}: ${e?.message ?? e}`);
      }
    }
    status({ webmcp: 'available', registered: names.length, tools: names, errors });
  }

  function unregister() {
    if (controller) { controller.abort(); controller = null; }
  }

  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.[TAG] !== 'to-page') return;
    const m = e.data;
    if (m.kind === 'result') { pending.get(m.id)?.(m.response); pending.delete(m.id); return; }
    if (m.kind === 'init') {
      toolDefs = m.tools ?? [];
      if (m.enabled && toolDefs.length) register();
      else { unregister(); status({ webmcp: mc() ? 'available' : 'unavailable', registered: 0, disabled: !m.enabled, error: m.error }); }
      return;
    }
    if (m.kind === 'enabled') {
      if (m.enabled) register();
      else { unregister(); status({ webmcp: mc() ? 'available' : 'unavailable', registered: 0, disabled: true }); }
    }
  });

  send({ kind: 'ready' });
})();
