const assert = require('node:assert/strict');
const { test } = require('node:test');

test('online catalog drives model metadata and exact upstream selection', async (t) => {
  process.env.TRAE_TOKEN = 'fixture-token';
  process.env.TRAE_USER_ID = 'fixture-user';
  const auth = require('../src/auth.js');
  auth.initAuth('cn');
  const client = require('../src/trae-client.js');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let catalogRequests = 0;
  let chatBody;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init.body);
    if (String(input).endsWith('/get_detail_param')) {
      catalogRequests++;
      const entries = body.function === 'solo_work_remote' ? [{
        config_name: 'new-live-model', usage: 'chat_completion', config_switch: true,
        display_config: { display_name: 'New live model' },
        context_window_tokens: { dev: 123456 },
        model_detail_list: [{
          model_name: 'new-live-model__dev', max_tokens: 2048,
          encrypted_model_params: 'fixture-only',
        }],
      }] : [];
      return Response.json({ config_info_list: entries });
    }
    assert.equal(String(input), 'https://fixture.invalid/api/agent/v3/llm_utils_chat');
    chatBody = body;
    return new Response('event:done\ndata:{"finish_reason":"stop"}\n\n');
  };

  const models = await client.getModels('https://fixture.invalid');
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'new-live-model');
  assert.equal(models[0].context_window, 123456);
  assert.equal(models[0].max_output_tokens, 2048);
  assert.ok(!JSON.stringify(models).includes('fixture-only'));
  await client.sendChatRequest([{ role: 'user', content: 'test' }], 'new-live-model', true, 'https://fixture.invalid');
  assert.equal(chatBody.function, 'solo_work_remote');
  assert.equal(chatBody.config_name, 'new-live-model');
  assert.equal(chatBody.model_name, 'new-live-model__dev');
  assert.equal(chatBody.encrypted_model_params, 'fixture-only');
  assert.equal(catalogRequests, 3, 'chat reuses the cached catalog');
  assert.equal(client.mapModel('claude-sonnet-4'), 'claude-sonnet-4');
  await assert.rejects(
    client.sendChatRequest([{ role: 'user', content: 'test' }], 'missing-model', true, 'https://fixture.invalid'),
    /absent from current Trae catalog/,
  );
});
