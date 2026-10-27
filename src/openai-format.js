/** Preserve native tool-call deltas and reasoning in the OpenAI surface. */
const { randomUUID } = require('node:crypto');
const { ToolCalls } = require('./native-tools');
const { upstreamEvents } = require('./upstream-events');

function usageOf(usage) {
  return { prompt_tokens: usage?.prompt_tokens || 0, completion_tokens: usage?.completion_tokens || 0, total_tokens: usage?.total_tokens || 0 };
}

async function handleOpenAIResponse(response, model, stream) {
  if (stream) return streamGenerator(response, model);
  const calls = new ToolCalls();
  let text = '', reasoning = '', finish = null, usage;
  for await (const packet of upstreamEvents(response)) {
    if (packet.event === 'output') {
      text += packet.data.response || ''; reasoning += packet.data.reasoning_content || '';
      calls.add(packet.data.tool_calls);
    }
    if (packet.event === 'token_usage') usage = packet.data;
    if (packet.event === 'done') finish = packet.data.finish_reason || 'stop';
  }
  if (!finish) throw new Error('Trae stream ended without a completion event');
  const tools = calls.values();
  return {
    id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: {
      role: 'assistant', content: text || (tools.length ? null : ''),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(tools.length ? { tool_calls: tools.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) } : {}),
    }, finish_reason: tools.length ? 'tool_calls' : finish }],
    usage: usageOf(usage),
  };
}

async function* streamGenerator(response, model) {
  const id = 'chatcmpl-' + randomUUID(), created = Math.floor(Date.now() / 1000);
  const calls = new ToolCalls();
  const emit = (delta, finish = null, usage) => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: usageOf(usage) } : {}) }) + '\n\n';
  let finish = null, usage;
  yield emit({ role: 'assistant' });
  for await (const packet of upstreamEvents(response)) {
    if (packet.event === 'output') {
      calls.add(packet.data.tool_calls);
      const delta = {};
      if (packet.data.response) delta.content = packet.data.response;
      if (packet.data.reasoning_content) delta.reasoning_content = packet.data.reasoning_content;
      if (packet.data.tool_calls?.length) delta.tool_calls = packet.data.tool_calls.map((call, index) => {
        const fn = call.function_call || call.function || {};
        const args = fn.partial_arguments ?? fn.arguments;
        return { index: call.index ?? index, ...(call.id ? { id: call.id, type: 'function' } : {}), function: {
          ...(fn.name ? { name: fn.name } : {}), ...(args != null ? { arguments: typeof args === 'string' ? args : JSON.stringify(args) } : {}),
        } };
      });
      if (Object.keys(delta).length) yield emit(delta);
    }
    if (packet.event === 'token_usage') usage = packet.data;
    if (packet.event === 'done') finish = packet.data.finish_reason || 'stop';
  }
  if (!finish) throw new Error('Trae stream ended without a completion event');
  const tools = calls.values();
  yield emit({}, tools.length ? 'tool_calls' : finish, usage);
  yield 'data: [DONE]\n\n';
}

module.exports = { handleOpenAIResponse };
