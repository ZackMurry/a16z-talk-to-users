// Local stand-in for POST /v1/messages (streaming) used to test the panel agent without an API key.
// Scripted policy: describe_sheet → propose_changes (Profit column) → get_plan_status(wait) → summary.
// Logs each request body to /tmp/mock-anthropic.jsonl for assertions.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT ?? 8787);
const LOG = '/tmp/mock-anthropic.jsonl';
fs.writeFileSync(LOG, '');

function nextStep(body) {
  const msgs = body.messages;
  const last = msgs.at(-1);
  const lastResults = Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result') : [];
  const usesById = new Map(msgs.filter(m => m.role === 'assistant').flatMap(m => m.content).filter(b => b.type === 'tool_use').map(b => [b.id, b]));
  if (!lastResults.length) return { text: 'Let me look at the sheet first.', tool: { name: 'describe_sheet', input: {} } };
  const prev = usesById.get(lastResults[0].tool_use_id);
  const result = (() => { try { return JSON.parse(lastResults[0].content); } catch { return {}; } })();
  if (prev.name === 'describe_sheet') {
    return { text: '', tool: { name: 'propose_changes', input: {
      title: 'Add Profit column', rationale: 'Profit by month = revenue minus COGS, marketing and opex.',
      assumptions: ['Profit = Revenue - COGS - Marketing - Opex'],
      operations: [
        { op: 'set_values', range: 'F1', values: [['Profit']] },
        { op: 'write_formula', range: 'F2:F10', formula: '=B{row}-C{row}-D{row}-E{row}' },
        { op: 'format_range', range: 'F1', bold: true },
        { op: 'format_range', range: 'F2:F10', number_format: 'currency', decimals: 0 },
      ] } } };
  }
  if (prev.name === 'propose_changes' || (prev.name === 'get_plan_status' && ['pending_approval', 'executing'].includes(result.status))) {
    return { text: prev.name === 'propose_changes' ? 'I’ve proposed a **Profit** column. Review the preview on the sheet and accept or reject it.' : '', tool: { name: 'get_plan_status', input: { plan_id: result.plan_id, wait_seconds: 120 } } };
  }
  if (prev.name === 'get_plan_status') {
    if (result.status === 'executed') return { text: 'Done — the Profit column is in **F2:F10** and every cell was verified. Total profit Jan–Sep is **$657,900** (15.2% margin).' };
    if (result.status === 'rejected') return { text: 'Okay, I left the sheet unchanged.' };
    return { text: `The change ended as **${result.status}**.` };
  }
  return { text: 'Done.' };
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); }

const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    fs.appendFileSync(LOG, JSON.stringify({ url: req.url, headers: { beta: req.headers['anthropic-beta'], key: req.headers['x-api-key'], browser: req.headers['anthropic-dangerous-direct-browser-access'] }, body: { ...body, tools: body.tools?.map(t => t.name) } }) + '\n');
    if (req.headers['x-api-key'] !== 'test-key') {
      res.writeHead(401, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    const step = nextStep(body);
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `msg_mock_${Date.now()}`;
    sse(res, 'message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    let index = 0;
    if (step.text) {
      sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const chunk of step.text.match(/.{1,12}/gs)) { sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: chunk } }); await new Promise(r => setTimeout(r, 25)); }
      sse(res, 'content_block_stop', { index });
      index++;
    }
    if (step.tool) {
      sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: step.tool.name, input: {} } });
      const json = JSON.stringify(step.tool.input);
      for (const chunk of json.match(/.{1,40}/gs) ?? ['{}']) sse(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: chunk } });
      sse(res, 'content_block_stop', { index });
    }
    sse(res, 'message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
    sse(res, 'message_stop', {});
    res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock Anthropic API on http://127.0.0.1:${PORT}`));
