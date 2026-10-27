const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleAnthropicResponse } = require('../src/anthropic-format.js');

test('native upstream tool calls become executable Anthropic tool_use blocks', async () => {
  const events = 'event:output\ndata:' + JSON.stringify({
    response: 'I will fetch the project.',
    tool_calls: [{ index: 0, id: 'call_fetch_1', type: 'function', function: {
      name: 'web_fetch', arguments: '{"url":"https://example.com/project"}',
    } }],
  }) + '\n\nevent:done\ndata:{"finish_reason":"tool_calls"}\n\n';
  const result = await handleAnthropicResponse(new Response(events), 'fixture', false, 1);
  const tool = result.content.find(block => block.type === 'tool_use');
  assert.ok(tool, 'tool call was returned as text/end_turn instead of executable tool_use');
  assert.equal(tool.name, 'web_fetch');
  assert.deepEqual(tool.input, { url: 'https://example.com/project' });
  assert.equal(result.stop_reason, 'tool_use');
});
