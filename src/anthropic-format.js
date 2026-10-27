/** Translate native Trae text/function-call events to Anthropic messages. */
const { randomUUID } = require('node:crypto');
const { ToolCalls } = require('./native-tools');
const { upstreamEvents } = require('./upstream-events');

function estimateTokens(text) {
  let tokens = 0;
  for (const char of text || '') tokens += char.charCodeAt(0) > 0x2000 ? 1.5 : 0.25;
  return Math.ceil(tokens);
}

function stopReason(reason, calls) {
  if (calls.length) return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function event(type, data) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }

async function handleAnthropicResponse(response, model, stream, inputTokens = 0) {
  if (stream) return streamGenerator(response, model, inputTokens);
  const calls = new ToolCalls();
  let text = '', finish = null, usage;
  for await (const packet of upstreamEvents(response)) {
    if (packet.event === 'output') { text += packet.data.response || ''; calls.add(packet.data.tool_calls); }
    if (packet.event === 'token_usage') usage = packet.data;
    if (packet.event === 'done') finish = packet.data.finish_reason || 'stop';
  }
  if (!finish) throw new Error('Trae stream ended without a completion event');
  const tools = calls.values();
  const content = text ? [{ type: 'text', text }] : [];
  content.push(...tools.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })));
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: 'msg_' + randomUUID().replace(/-/g, ''), type: 'message', role: 'assistant', model, content,
    stop_reason: stopReason(finish, tools), stop_sequence: null,
    usage: { input_tokens: usage?.prompt_tokens ?? inputTokens, output_tokens: usage?.completion_tokens ?? estimateTokens(text + tools.map(call => call.arguments).join('')) },
  };
}

async function* streamGenerator(response, model, inputTokens) {
  yield event('message_start', { message: {
    id: 'msg_' + randomUUID().replace(/-/g, ''), type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 },
  } });
  const calls = new ToolCalls();
  let index = 0, textStarted = false, text = '', finish = null, usage;
  try {
    for await (const packet of upstreamEvents(response)) {
      if (packet.event === 'output') {
        calls.add(packet.data.tool_calls);
        if (packet.data.response) {
          if (!textStarted) { yield event('content_block_start', { index, content_block: { type: 'text', text: '' } }); textStarted = true; }
          text += packet.data.response;
          yield event('content_block_delta', { index, delta: { type: 'text_delta', text: packet.data.response } });
        }
      }
      if (packet.event === 'token_usage') usage = packet.data;
      if (packet.event === 'done') finish = packet.data.finish_reason || 'stop';
    }
    if (!finish) throw new Error('Trae stream ended without a completion event');
    if (textStarted) { yield event('content_block_stop', { index }); index++; }
    const tools = calls.values();
    for (const call of tools) {
      yield event('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
      yield event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
      yield event('content_block_stop', { index });
      index++;
    }
    yield event('message_delta', { delta: { stop_reason: stopReason(finish, tools), stop_sequence: null }, usage: {
      input_tokens: usage?.prompt_tokens ?? inputTokens,
      output_tokens: usage?.completion_tokens ?? estimateTokens(text + tools.map(call => call.arguments).join('')),
    } });
    yield event('message_stop', {});
  } catch (error) {
    yield event('error', { error: { type: 'api_error', message: error.message } });
  }
}

/** Legacy helper retained for direct consumers; API responses use native calls only. */
function parseToolCalls(text) {
  const result = [];
  let offset = 0;
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    if (match.index > offset) result.push({ type: 'text', text: text.slice(offset, match.index) });
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) result.push({ type: 'tool_use', name: parsed.name, input: parsed.arguments || parsed.input || parsed.parameters || {} });
      else result.push({ type: 'text', text: match[0] });
    } catch { result.push({ type: 'text', text: match[0] }); }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) result.push({ type: 'text', text: text.slice(offset) });
  return result;
}

module.exports = { handleAnthropicResponse, parseToolCalls, estimateTokens };
