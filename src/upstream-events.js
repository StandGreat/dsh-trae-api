/** Decode named SSE events across arbitrary UTF-8 and network boundaries. */
async function* upstreamEvents(response) {
  if (!response.ok) throw new Error('Trae upstream HTTP ' + response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function parse(packet) {
    let event = 'message';
    const data = [];
    for (const line of packet.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    const value = data.join('\n');
    if (value === '[DONE]') return { event: 'done', data: { finish_reason: 'stop' } };
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new Error('Trae returned invalid SSE JSON'); }
    if (event === 'error') throw new Error(`Trae upstream error ${parsed.code}: ${parsed.message || parsed.error}`);
    return { event, data: parsed };
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const packet = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const parsed = parse(packet);
        if (parsed) { yield parsed; if (parsed.event === 'done') return; }
      }
      if (done) { const parsed = parse(buffer); if (parsed) yield parsed; return; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

module.exports = { upstreamEvents };
