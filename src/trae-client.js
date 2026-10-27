/**
 * trae-client.js - Trae API client
 *
 * Communicates with Trae backend API with 3-level endpoint fallback:
 * 1. /api/agent/v3/llm_utils_chat (primary - lightweight chat)
 * 2. /api/ide/v1/chat (fallback 1 - standard chat)
 * 3. /api/agent/v3/create_agent_task (fallback 2 - full agent)
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');
const { upstreamTools, upstreamToolChoice } = require('./native-tools');

const IDE_VERSION_CN = process.env.TRAE_IDE_VERSION || '3.4.6';
const IDE_VERSION_CODE_CN = process.env.TRAE_IDE_VERSION_CODE || '20261021';

function hashDeviceId(machineId) {
  return crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32);
}

function generateMachineId() {
  return crypto.randomBytes(32).toString('hex');
}

function buildHeaders(token, userId) {
  const machineId = generateMachineId();
  const requestId = crypto.randomUUID();
  return {
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-uid': userId || '',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-device-id': hashDeviceId(machineId),
    'x-machine-id': machineId,
    'x-request-id': requestId,
    'x-ide-version': IDE_VERSION_CN,
    'x-ide-version-code': IDE_VERSION_CODE_CN,
    'x-app-version-code': IDE_VERSION_CODE_CN,
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
}

function mapModel(requestedModel) {
  if (requestedModel === 'auto') return 'glm-5.2';
  return requestedModel;
}

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 0x2000) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

function getMessageContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(b => b.text || b.content || '').join(' ');
  }
  return '';
}

function truncateMessages(messages, maxTokens) {
  if (!maxTokens) {
    maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '200000', 10);
  }
  if (messages.length === 0) return messages;

  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(getMessageContent(m));
  }

  if (totalTokens <= maxTokens) return messages;

  console.log(`[trae-client] Context truncation: ${totalTokens} est. tokens > ${maxTokens} limit`);

  const result = [];
  let startIdx = 0;

  if (messages[0] && messages[0].role === 'system') {
    result.push(messages[0]);
    startIdx = 1;
    totalTokens = estimateTokens(getMessageContent(messages[0]));
  }

  const recentMessages = [];
  for (let i = messages.length - 1; i >= startIdx; i--) {
    const msgTokens = estimateTokens(getMessageContent(messages[i]));
    if (totalTokens + msgTokens > maxTokens && recentMessages.length > 0) {
      console.log(`[trae-client] Truncated: kept ${result.length + recentMessages.length}/${messages.length} messages`);
      break;
    }
    recentMessages.unshift(messages[i]);
    totalTokens += msgTokens;
  }

  if (recentMessages.length < messages.length - startIdx) {
    const dropped = messages.length - startIdx - recentMessages.length;
    result.push({
      role: 'system',
      content: `[Note: ${dropped} earlier messages were truncated to fit context window]`,
    });
  }

  result.push(...recentMessages);
  console.log(`[trae-client] Final messages: ${result.length}, ~${totalTokens} tokens`);
  return result;
}

function buildChatBody(messages, model, stream, options) {
  const truncated = truncateMessages(messages);
  const sessionId = crypto.randomUUID();

  const body = {
    messages: truncated.map(m => ({
      role: m.role,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    })),
    model: model,
    function: 'chat_v3',
    config_name: model,
    stream: true,
    request_id: sessionId,
    session_id: sessionId,
  };

  const maxTokens = options && options.maxTokens;
  if (options?.tools?.length) body.tools = upstreamTools(options.tools);
  const choice = upstreamToolChoice(options?.toolChoice);
  if (choice !== undefined && choice !== null) body.tool_choice = choice;
  if (maxTokens && typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  return body;
}

async function sendChatRequest(messages, model, stream, baseUrl, options) {
  const token = auth.getToken();
  const userId = auth.getUserId();

  if (!token) {
    const err = new Error('No auth token available');
    err.status = 401;
    throw err;
  }

  if (auth.needsRefresh()) {
    await auth.refreshToken();
  }

  const traeModel = mapModel(model);
  const catalog = await loadModelCatalog(baseUrl);
  const selected = catalog.find(entry => entry.id === traeModel);
  if (!selected) {
    const error = new Error('Model is absent from current Trae catalog: ' + traeModel);
    error.status = 400;
    throw error;
  }
  const body = buildChatBody(messages, traeModel, stream, options);
  Object.assign(body, {
    function: selected.wireFunction,
    config_name: selected.id,
    model: selected.wireModel,
    model_name: selected.wireModel,
    config_source: selected.configSource,
    encrypted_model_params: selected.encryptedModelParams,
    is_custom_model: false,
    provider: '',
  });
  const headers = buildHeaders(auth.getToken(), userId);

  const endpoints = [
    '/api/agent/v3/llm_utils_chat',
    '/api/ide/v1/chat',
    '/api/agent/v3/create_agent_task',
  ];

  let lastError = null;
  let lastStatus = 502;

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;
    console.log(`[trae-client] Trying endpoint: ${endpoint} (model: ${traeModel})`);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        console.log(`[trae-client] Success with endpoint: ${endpoint}`);
        return { response: resp, model: traeModel, endpoint };
      }

      const text = await resp.text();
      console.warn(`[trae-client] Endpoint ${endpoint} returned ${resp.status}: ${text.substring(0, 500)}`);
      const err = new Error(`${endpoint}: ${resp.status} ${text.substring(0, 500)}`);
      err.status = resp.status;
      err.endpoint = endpoint;
      lastError = err;
      lastStatus = resp.status;
    } catch (err) {
      console.warn(`[trae-client] Endpoint ${endpoint} error: ${err.message}`);
      err.status = err.status || 502;
      lastError = err;
      lastStatus = err.status;
    }
  }

  if (lastError) {
    lastError.status = lastStatus;
    throw lastError;
  }
  throw new Error('All endpoints failed');
}

const catalogCache = new Map();
const catalogPending = new Map();
async function loadModelCatalog(baseUrl) {
  const key = baseUrl + ':' + auth.getUserId();
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.models;
  if (catalogPending.has(key)) return catalogPending.get(key);
  const pending = (async () => {
    const models = new Map();
    for (const wireFunction of ['chat_v3', 'solo_work_remote', 'solo_work_lite']) {
      const response = await fetch(baseUrl + '/api/ide/v1/get_detail_param', {
        method: 'POST', headers: buildHeaders(auth.getToken(), auth.getUserId()),
        body: JSON.stringify({ function: wireFunction, config_names: null, need_prompt: false, poly_prompt: true }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('Trae model catalog HTTP ' + response.status);
      const payload = await response.json();
      if (payload.code && payload.code !== 0) throw new Error('Trae model catalog business error ' + payload.code);
      const entries = payload.config_info_list ?? payload.data?.config_info_list ?? [];
      for (const entry of entries) {
        const name = entry.display_config?.display_name;
        if (entry.usage !== 'chat_completion' || entry.config_switch === false || !name || /_advisor/.test(entry.config_name)) continue;
        const detail = entry.model_detail_list?.find(model => model.model_name?.endsWith('__dev')) ?? entry.model_detail_list?.[0];
        const contextWindow = entry.context_window_tokens?.dev;
        if (!detail || !contextWindow || !detail.max_tokens || models.has(entry.config_name)) continue;
        models.set(entry.config_name, {
          id: entry.config_name, name, contextWindow, maxTokens: detail.max_tokens,
          wireFunction, wireModel: detail.model_name, configSource: entry.config_source ?? 1,
          encryptedModelParams: detail.encrypted_model_params,
        });
      }
    }
    if (!models.size) throw new Error('Trae returned no chat models for this account');
    const result = [...models.values()];
    catalogCache.set(key, { at: Date.now(), models: result });
    return result;
  })().finally(() => catalogPending.delete(key));
  catalogPending.set(key, pending);
  return pending;
}

async function getModels(baseUrl) {
  const catalog = await loadModelCatalog(baseUrl);
  return catalog.map(({id, name, contextWindow, maxTokens}) => ({
    id, name, object: 'model', owned_by: 'trae',
    context_window: contextWindow, max_output_tokens: maxTokens,
  }));
}

module.exports = {
  sendChatRequest,
  getModels,
  mapModel,
};
