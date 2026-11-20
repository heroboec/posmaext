'use strict';

// Transient, extension-worker-only diagnostics. Never persisted or sent to the site.
const PM_DIAG = (() => {
  const records = new Map(), dropped = new Set(), secrets = new Set();
  const maxBytes = 16 * 1024 * 1024, maxBody = 512 * 1024, ttl = 60 * 60 * 1000;
  let order = [], head = 0, bytes = 0, sequence = 0;
  const scope = (pack, bid) => JSON.stringify([pack, bid]);
  const queryKey = query => JSON.stringify([query?.platform, query?.identifier_type, query?.identifier]);
  function prune() {
    while (head < order.length) {
      const id = order[head], record = records.get(id);
      if (!record) { head++; continue; }
      if (bytes <= maxBytes && record.time >= Date.now() - ttl) break;
      bytes -= record.size; records.delete(id); head++;
      dropped.add(scope(record.data.packId, record.data.bidId));
    }
    if (head > 1024) { order = order.slice(head); head = 0; }
  }
  function start(data) {
    const id = ++sequence, time = Date.now();
    const value = JSON.parse(JSON.stringify({ ...data, id, time }));
    const size = JSON.stringify(value).length * 2;
    records.set(id, { data: value, size, time }); order.push(id); bytes += size; prune();
    return id;
  }
  function update(id, patch) {
    const record = records.get(id);
    if (!record) return;
    const value = { ...patch };
    if (typeof value.body === 'string' && value.body.length > maxBody) {
      value.originalLength = value.body.length; value.body = value.body.slice(0, maxBody); value.truncated = true;
    }
    bytes -= record.size;
    Object.assign(record.data, value);
    record.size = JSON.stringify(record.data).length * 2;
    bytes += record.size; prune();
  }
  function error(id, err) {
    const record = records.get(id);
    if (!record) return;
    const message = String(err?.message || err), type = err?.name || 'Error';
    const errors = record.data.errors || [];
    if (errors.at(-1)?.message !== message || errors.at(-1)?.type !== type) errors.push({ message, type });
    update(id, { error: message, errorType: type, errors, ended: Date.now() });
  }
  async function capture(response, id) {
    update(id, { status: response.status, retryAfter: response.headers?.get?.('Retry-After') || '' });
    try {
      if (typeof response.text === 'function') {
        const body = await response.text();
        update(id, { body, ended: Date.now() });
        return { json: () => JSON.parse(body) };
      }
      // Synthetic adapters may expose json() only.
      const json = await response.json();
      update(id, { body: JSON.stringify(json) || '', ended: Date.now() });
      return { json: () => json };
    } catch (err) {
      error(id, err);
      return { json: () => { throw err; } };
    }
  }
  function addSecrets(values) {
    for (const value of values) if (typeof value === 'string' && value) {
      secrets.add(value);
      secrets.add(JSON.stringify(value).slice(1, -1));
      try { secrets.add(encodeURIComponent(value)); } catch (_) { /* Preserve malformed Unicode as text, never break checks. */ }
    }
  }
  function redact(value) {
    if (typeof value === 'string') {
      for (const secret of [...secrets].sort((a,b) => b.length - a.length)) value = value.split(secret).join('[API-ключ скрыт]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v)]));
    return value;
  }
  function rows(packId, bidId, contextId, values) {
    // One snapshot per extraction context; retries do not duplicate secret strings.
    const existing = new Set([...records.values()].filter(r => r.data.kind === 'row' &&
      r.data.packId === packId && r.data.bidId === bidId && r.data.contextId === contextId).map(r => r.data.index));
    values.forEach((value, index) => {
      if (!existing.has(index)) start({ kind: 'row', packId, bidId, contextId, index, value });
    });
  }
  function link(packId, bidId, contextId, index, query) {
    start({ kind: 'link', packId, bidId, contextId, index, queryKey: queryKey(query) });
  }
  function get(packId, bidId, query, rowId) {
    prune();
    const all = [...records.values()].map(r => r.data).filter(r => r.packId === packId && r.bidId === bidId);
    const filtered = !!query || rowId !== undefined;
    const refs = query ? all.filter(r => r.kind === 'link' && r.queryKey === queryKey(query)) :
      rowId !== undefined ? all.filter(r => r.kind === 'row' && r.id === rowId) : [];
    const relevant = row => !filtered || refs.some(ref => ref.contextId === row.contextId && ref.index === row.index);
    const ai = all.filter(r => r.kind === 'ai' && (!filtered || refs.some(ref =>
      ref.contextId === r.contextId && r.indexes.includes(ref.index))));
    const socialKeys = query ? [queryKey(query)] : all.filter(r => r.kind === 'link' && relevant(r)).map(r => r.queryKey);
    const sourceRows = all.filter(r => r.kind === 'row');
    const selectedRows = sourceRows.filter(relevant);
    const social = all.filter(r => r.kind === 'social' && (!filtered || socialKeys.includes(r.queryKey)));
    return redact({
      available: selectedRows.length + ai.length + social.length > 0, truncated: dropped.has(scope(packId, bidId)),
      rowChoices: sourceRows.map(({id,index,time}) => ({id,index,time})),
      rows: selectedRows, ai, social,
    });
  }
  function clear(packId) {
    for (const [id, record] of records) if (record.data.packId === packId) {
      bytes -= record.size; records.delete(id);
    }
    for (const key of dropped) if (JSON.parse(key)[0] === packId) dropped.delete(key);
    order = order.slice(head).filter(id => records.has(id)); head = 0;
  }
  return { start, update, error, capture, addSecrets, rows, link, get, clear, queryKey };
})();
