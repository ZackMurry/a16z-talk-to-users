// chrome.storage.local wrapper with a serialized write queue (service worker events can interleave).

let queue = Promise.resolve();

export function update(key, fn) {
  const run = queue.then(async () => {
    const cur = (await chrome.storage.local.get(key))[key];
    const next = await fn(cur);
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

export async function get(key, fallback) {
  return (await chrome.storage.local.get(key))[key] ?? fallback;
}

export const uid = prefix => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function putIn(collection, id, value) {
  return update(collection, cur => ({ ...(cur ?? {}), [id]: value }));
}

export function patchIn(collection, id, patch) {
  return update(collection, cur => {
    if (!cur?.[id]) throw new Error(`${collection}/${id} not found`);
    const p = typeof patch === 'function' ? patch(cur[id]) : patch;
    return { ...cur, [id]: { ...cur[id], ...p } };
  });
}

const AUDIT_CAP = 2000;

export function audit(event) {
  const e = { id: uid('evt'), ts: Date.now(), status: 'info', ...event };
  return update('audit', cur => [e, ...(cur ?? [])].slice(0, AUDIT_CAP)).then(() => e);
}
