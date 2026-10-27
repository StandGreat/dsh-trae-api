const { randomUUID } = require('node:crypto');

/** Collect Trae/OpenAI function-call deltas by their stable call index. */
class ToolCalls {
  constructor() { this.calls = new Map(); }

  add(deltas) {
    for (const [position, delta] of (deltas || []).entries()) {
      const index = delta.index ?? position;
      let call = this.calls.get(index);
      if (!call) {
        call = { index, id: '', name: '', arguments: '' };
        this.calls.set(index, call);
      }
      if (delta.id) {
        if (call.id && call.id !== delta.id) throw new Error('Upstream changed a tool call id');
        call.id = delta.id;
      }
      const fn = delta.function_call || delta.function || {};
      if (fn.name && fn.name !== call.name) call.name += fn.name;
      const args = fn.partial_arguments ?? fn.arguments;
      if (args !== undefined && args !== null) call.arguments += typeof args === 'string' ? args : JSON.stringify(args);
    }
  }

  values() {
    return [...this.calls.values()].sort((a, b) => a.index - b.index).map(call => {
      if (!call.name) throw new Error('Upstream returned a tool call without a name');
      let input;
      try { input = JSON.parse(call.arguments || '{}'); }
      catch { throw new Error('Upstream returned incomplete JSON arguments for tool ' + call.name); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be an object');
      call.id ||= 'call_' + randomUUID().replace(/-/g, '');
      return { ...call, input };
    });
  }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return (content || []).map(block => block.type === 'text' ? block.text : block.type === 'image' ? '[Image]' : '').join('');
}

function wireCalls(calls) {
  return calls.map((call, index) => {
    const fn = call.function_call || call.function || { name: call.name, arguments: JSON.stringify(call.input ?? {}) };
    return { index, id: call.id, type: 'function', function_call: { name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) } };
  });
}

/** Keep tool calls/results as protocol messages rather than model-visible labels. */
function anthropicMessages(messages, system) {
  const result = [];
  if (system) result.push({ role: 'system', content: textContent(system) });
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      result.push({ role: message.role, content: message.content ?? '' });
      continue;
    }
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool_use');
      result.push({ role: 'assistant', content: textContent(message.content), ...(calls.length ? { tool_calls: wireCalls(calls) } : {}) });
      continue;
    }
    let text = '';
    const flush = () => { if (text) { result.push({ role: message.role, content: text }); text = ''; } };
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        flush();
        const content = textContent(block.content) || '(empty)';
        result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error ? 'Tool execution error: ' + content : content });
      } else if (block.type === 'text') text += block.text;
      else if (block.type === 'image') text += '[Image]';
    }
    flush();
  }
  return result;
}

function openaiMessages(messages) {
  return messages.map(message => ({
    role: message.role === 'developer' ? 'system' : message.role,
    content: textContent(message.content),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length ? { tool_calls: wireCalls(message.tool_calls) } : {}),
  }));
}

/** Trae expects the entire JSON Schema as a JSON string, including nested fields. */
function upstreamTools(tools) {
  return (tools || []).map(tool => {
    const fn = tool.function || tool;
    const schema = fn.input_schema ?? fn.parameters ?? { type: 'object', properties: {} };
    return { type: 'function', function: { name: fn.name, description: fn.description || '', parameters: typeof schema === 'string' ? schema : JSON.stringify(schema) } };
  });
}

function upstreamToolChoice(choice) {
  if (!choice || typeof choice === 'string') return choice;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'auto' || choice.type === 'none') return choice.type;
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return choice;
}

module.exports = { ToolCalls, anthropicMessages, openaiMessages, upstreamTools, upstreamToolChoice };
