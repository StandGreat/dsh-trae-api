const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleAnthropicResponse } = require('../src/anthropic-format.js');
const { handleOpenAIResponse } = require('../src/openai-format.js');
const { ToolCalls, anthropicMessages, upstreamTools } = require('../src/native-tools.js');

function response(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
    controller.close();
  } }));
}

function fixture() {
  return [
    { response: 'Reading the project.', tool_calls: [
      { index: 1, id: 'call_b', function_call: { name: 'read_file', arguments: '{"path":' } },
      { index: 0, id: 'call_a', function_call: { name: 'web_fetch', arguments: '{"url":' } },
    ] },
    { response: '', tool_calls: [
      { index: 0, id: '', function_call: { name: '', arguments: '"https://example.com/项目"}' } },
      { index: 1, id: '', function_call: { name: '', arguments: '"README.md"}' } },
    ] },
  ].map(data => 'event:output\ndata:' + JSON.stringify(data) + '\n\n').join('') + 'event:done\ndata:{"finish_reason":"stop"}\n\n';
}

test('parallel native calls survive UTF-8/network fragmentation and finish as tool_use', async () => {
  const stream = await handleAnthropicResponse(response(fixture()), 'fixture', true);
  let text = ''; for await (const chunk of stream) text += chunk;
  const packets = [...text.matchAll(/data: (.+)/g)].map(match => JSON.parse(match[1]));
  const tools = packets.filter(packet => packet.type === 'content_block_start' && packet.content_block.type === 'tool_use');
  assert.deepEqual(tools.map(packet => packet.content_block.id), ['call_a', 'call_b']);
  assert.deepEqual(tools.map(packet => packet.content_block.name), ['web_fetch', 'read_file']);
  const argumentsList = packets.filter(packet => packet.delta?.type === 'input_json_delta').map(packet => JSON.parse(packet.delta.partial_json));
  assert.deepEqual(argumentsList, [{ url: 'https://example.com/项目' }, { path: 'README.md' }]);
  assert.equal(packets.find(packet => packet.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('OpenAI surface preserves native calls and the tool_calls finish reason', async () => {
  const result = await handleOpenAIResponse(response(fixture()), 'fixture', false);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.tool_calls[0].id, 'call_a');
  assert.equal(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).url, 'https://example.com/项目');
});

test('XML-looking assistant text is not promoted to executable calls', async () => {
  const result = await handleAnthropicResponse(new Response('event:output\ndata:' + JSON.stringify({ response: '<web_fetch url="https://example.com"></web_fetch>' }) + '\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n'), 'fixture', false);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.content[0].type, 'text');
});

test('incomplete tool arguments and truncated streams fail explicitly', async () => {
  const calls = new ToolCalls();
  calls.add([{ index: 0, id: 'call_a', function_call: { name: 'web_fetch', arguments: '{"url":' } }]);
  assert.throws(() => calls.values(), /incomplete JSON/);
  await assert.rejects(handleAnthropicResponse(new Response('event:output\ndata:{"response":"partial"}\n\n'), 'fixture', false), /without a completion/);
});

test('nested schemas and interleaved tool results retain their structure', () => {
  const schema = { type: 'object', properties: { request: { type: 'object', properties: { mode: { enum: ['read', 'write'] } }, required: ['mode'] } }, required: ['request'] };
  assert.deepEqual(JSON.parse(upstreamTools([{ name: 'task', input_schema: schema }])[0].function.parameters), schema);
  const messages = anthropicMessages([{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call_a', content: 'first result' },
    { type: 'text', text: 'Continue with the second file.' },
    { type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: 'second result' }] },
  ] }], 'Retain the workspace rules.');
  assert.deepEqual(messages.map(message => message.role), ['system', 'tool', 'user', 'tool']);
  assert.equal(messages[1].tool_call_id, 'call_a');
  assert.equal(messages[3].tool_call_id, 'call_b');
  const failed = anthropicMessages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'File not found', is_error: true }] }]);
  assert.equal(failed[0].role, 'tool');
  assert.match(failed[0].content, /^Tool execution error:/);
});
