const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleOpenAIResponse } = require('../src/openai-format.js');
const { handleAnthropicResponse } = require('../src/anthropic-format.js');

function response(parts) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  }));
}

async function collect(stream) {
  let text = '';
  for await (const part of stream) text += part;
  return text;
}

const failure = 'event:error\ndata:{"code":3003,"message":"fixture failure"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n';

test('non-streaming formats reject upstream business errors', async () => {
  await assert.rejects(handleOpenAIResponse(response([failure]), 'fixture', false), /3003/);
  await assert.rejects(handleAnthropicResponse(response([failure]), 'fixture', false, 1), /3003/);
});

test('Anthropic streaming preserves error events split across network chunks', async () => {
  const stream = await handleAnthropicResponse(response([
    'event:error\n', 'data:{"code":3003,"message":"fixture failure"}\n\n',
  ]), 'fixture', true, 1);
  const text = await collect(stream);
  assert.match(text, /event: error/);
  assert.match(text, /3003/);
});

test('OpenAI streaming preserves output events split across network chunks', async () => {
  const stream = await handleOpenAIResponse(response([
    'event:output\n', 'data:{"response":"OK"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n',
  ]), 'fixture', true);
  const text = await collect(stream);
  assert.match(text, /"content":"OK"/);
  assert.match(text, /data: \[DONE\]/);
});

test('OpenAI streaming rejects upstream business errors', async () => {
  const stream = await handleOpenAIResponse(response([failure]), 'fixture', true);
  await assert.rejects(collect(stream), /3003/);
});
