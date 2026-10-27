const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');

test('HTTP tool round trip preserves schema, call id, and tool result history', async (t) => {
  process.env.TRAE_TOKEN = 'fixture-token';
  process.env.TRAE_USER_ID = 'fixture-user';
  process.env.HOST = '127.0.0.1';
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const schema = { type: 'object', properties: { url: { type: 'string', enum: ['https://example.com/project'] } }, required: ['url'], additionalProperties: false };
  const observed = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('http://127.0.0.1:')) return realFetch(input, init);
    const body = JSON.parse(init.body);
    if (String(input).endsWith('/get_detail_param')) {
      return Response.json({ config_info_list: [{
        config_name: 'fixture-model', usage: 'chat_completion', display_config: { display_name: 'Fixture' },
        context_window_tokens: { dev: 32000 }, model_detail_list: [{ model_name: 'fixture-model__dev', max_tokens: 4096 }],
      }] });
    }
    observed.push(body);
    upstreamCalls++;
    if (upstreamCalls === 1) {
      return new Response('event:output\ndata:' + JSON.stringify({ response: '', tool_calls: [
        { index: 0, id: 'call_fixture', type: 'function', function_call: { name: 'web_fetch', arguments: '{"url":' } },
      ] }) + '\n\nevent:output\ndata:' + JSON.stringify({ response: '', tool_calls: [
        { index: 0, id: '', type: 'function', function_call: { name: '', arguments: '"https://example.com/project"}' } },
      ] }) + '\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n');
    }
    return new Response('event:output\ndata:{"response":"PROJECT-RESULT-OK"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n');
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const { startServer } = require('../src/server-core.js');
  const handle = startServer({ port: 0, apiKey: 'fixture-key', quiet: true });
  t.after(() => new Promise(resolve => { handle.server.close(resolve); handle.server.closeAllConnections(); }));
  if (!handle.server.listening) await once(handle.server, 'listening');
  const url = `http://127.0.0.1:${handle.server.address().port}/v1/messages`;
  const tools = [{ name: 'web_fetch', description: 'Read a page', input_schema: schema }];
  const messages = [{ role: 'user', content: 'Read the project page and return its verification code.' }];
  const request = async (history) => {
    const response = await realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-key' }, body: JSON.stringify({ model: 'fixture-model', tools, messages: history, max_tokens: 1024, stream: false }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await request(messages);
  const call = first.content.find(block => block.type === 'tool_use');
  assert.ok(call, 'DSH needs a real tool_use, not XML text or end_turn');
  assert.equal(first.stop_reason, 'tool_use');
  assert.equal(call.id, 'call_fixture');
  assert.deepEqual(call.input, { url: 'https://example.com/project' });
  assert.deepEqual(JSON.parse(observed[0].tools[0].function.parameters), schema);
  assert.ok(!JSON.stringify(observed[0].messages).includes('<tool_call>'));

  const next = await request([...messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'PROJECT-RESULT-OK' }] }]);
  const assistant = observed[1].messages.find(message => message.tool_calls?.length);
  const result = observed[1].messages.find(message => message.role === 'tool');
  assert.equal(assistant.tool_calls[0].id, call.id);
  assert.equal(result.tool_call_id, call.id);
  assert.equal(result.content[0].text, 'PROJECT-RESULT-OK');
  assert.equal(next.stop_reason, 'end_turn');
  assert.equal(next.content[0].text, 'PROJECT-RESULT-OK');
});
