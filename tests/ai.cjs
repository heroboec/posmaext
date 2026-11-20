const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const options = { url: 'chrome-extension://test/options.html' };
const source = { url: 'https://example.test/bids', frameId: 0, tab: { id: 7, index: 0 } };
const catalog = [{ platform: 'instagram', object_type: 'profile', operation: 'fetch', identifier_types: ['username'] }];
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setImmediate(r)); };
function setup() {
  const listeners = [], requests = [], waits = [];
  let connectListener;
  const ctx = vm.createContext({
    indexedDB: new IDBFactory(), crypto: webcrypto, TextEncoder, URL, AbortController, AbortSignal, DOMException,
    Date, Headers, setTimeout: (fn, ms) => { waits.push(ms); queueMicrotask(fn); }, clearTimeout() {},
    chrome: { runtime: { getURL: p => 'chrome-extension://test/' + p,
      onMessage: { addListener: fn => listeners.push(fn) }, onConnect: { addListener: fn => { connectListener = fn; } } },
      permissions: { contains: async () => true }, tabs: { create: async () => ({}), get: async () => ({ url: source.url }),
        sendMessage: async (tab, msg) => ({ ok: true, entries: msg.entries.map(e => ({ bidId: e.bidId, status: e.status })) }) } },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({
        choices: [{ message: { content: JSON.stringify({ accounts: [{ index: 0, type: 'username', identifier: 'test_user' }] }) } }],
      }) };
    },
  });
  for (const file of ['social-common.js', 'social-store.js', 'diagnostics.js', 'social-worker.js', 'ai-worker.js']) {
    vm.runInContext(fs.readFileSync('extension/' + file, 'utf8'), ctx);
  }
  vm.runInContext('globalThis.db = PM_DB', ctx);
  const send = (msg, sender = source) => new Promise(resolve => {
    for (const listener of listeners) if (listener(msg, sender, resolve)) return;
    resolve({ ok: false, error: 'No handler' });
  });
  const configure = async (extra = {}) => {
    await send({ action: 'sc-config-save', config: { url: 'https://social.example.test/', key: 'SOCIAL_TEST_KEY', mapping: { Instagram: 'instagram' } } }, options);
    await ctx.db.set('catalog', catalog);
    return send({ action: 'ai-config-save', config: { provider: 'custom', url: 'https://ai.example.test/v1/',
      key: 'AI_TEST_KEY', model: 'test-model', concurrency: 2, ...extra } }, options);
  };
  const create = async (count = 1) => {
    const result = await send({ action: 'sc-auto-create', packageId: webcrypto.randomUUID(),
      entries: Array.from({ length: count }, (_, i) => ({ bidId: String(42 + i), status: '2', category: 'Instagram',
        platform: 'instagram', title: 'Synthetic title', description: 'Synthetic description', format: '', properties: [] })) });
    assert.equal(result.ok, true, result.error); return result;
  };
  const extract = (run, bidId = '42', rows = ['test_user:SYNTHETIC_PASSWORD']) =>
    send({ action: 'ai-extract', id: run.id, runId: run.runId, bidId, rows, pageRows: rows.length });
  const connect = id => connectListener({ name: 'pm-review:' + id + ':client',
    sender: { url: 'chrome-extension://test/review.html' }, onDisconnect: { addListener() {} } });
  return { ctx, send, configure, create, extract, requests, waits, connect };
}

test('AI: credentials protected, custom endpoint binding and HTTPS validation', async () => {
  const w = setup(); assert.equal((await w.configure()).ok, true);
  assert.equal((await w.send({ action: 'ai-config-get' })).ok, false);
  const config = await w.send({ action: 'ai-config-get' }, options);
  assert.equal(config.hasKey, true); assert.equal(JSON.stringify(config).includes('AI_TEST_KEY'), false);
  assert.equal((await w.configure({ url: 'https://other.example.test/v1/', key: '' })).ok, true);
  assert.equal((await w.send({ action: 'ai-config-get' }, options)).hasKey, false);
  assert.equal((await w.configure({ url: 'http://remote.example.test/' })).ok, false);
});
test('diagnostics: failed AI HTTP body and evaluated row are available only to the review page', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  w.ctx.fetch = async () => ({ ok: false, status: 400, headers: new Headers(),
    text: async () => 'SYNTHETIC_GATEWAY_RESPONSE AI_TEST_KEY' });
  assert.equal((await w.extract(run)).ok, false);
  const before = w.requests.length;
  assert.equal((await w.send({ action: 'sc-diagnostics', id: run.id, bidId: '42' })).ok, false);
  assert.equal((await w.send({ action: 'sc-diagnostics', id: run.id, bidId: '42' }, options)).ok, false);
  const result = await w.send({ action: 'sc-diagnostics', id: run.id, bidId: '42' }, { url: 'chrome-extension://test/review.html' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.diagnostics.rows[0].value, 'test_user:SYNTHETIC_PASSWORD');
  assert.match(result.diagnostics.ai[0].body, /SYNTHETIC_GATEWAY_RESPONSE/);
  assert.equal(result.diagnostics.ai[0].status, 400);
  assert.doesNotMatch(JSON.stringify(result), /AI_TEST_KEY|SOCIAL_TEST_KEY/);
  assert.doesNotMatch(JSON.stringify(await w.ctx.db.get('package:' + run.id)), /SYNTHETIC_PASSWORD|SYNTHETIC_GATEWAY_RESPONSE/);
  assert.equal(w.requests.length, before);
});

test('AI: uses full row with title and fallback format; persists only verified logins', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  const result = await w.extract(run); assert.equal(result.ok, true, result.error);
  assert.equal(w.requests[0].url, 'https://ai.example.test/v1/chat/completions');
  const body = JSON.parse(w.requests[0].init.body);
  assert.match(body.messages[1].content, /Synthetic title/);
  assert.match(body.messages[1].content, /test_user:SYNTHETIC_PASSWORD/);
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.entries[0].jobs[0].query.identifier, 'test_user');
  assert.equal(pack.entries[0].extractionState, 'ready');
  assert.doesNotMatch(JSON.stringify(pack), /SYNTHETIC_PASSWORD|AI_TEST_KEY/);
  assert.equal((await w.extract(run)).ok, true);
  assert.equal(w.requests.length, 1, 'already extracted identifiers are not re-extracted');
});

test('AI: malformed identifier gets ten retries two seconds apart without echoing secrets', async () => {
  const w = setup(); await w.configure(); const run = await w.create(); let attempts = 0;
  w.ctx.fetch = async () => { attempts++; return { ok: true, status: 200, headers: new Headers(), json: async () => ({
    choices: [{ message: { content: '{"accounts":[{"index":0,"type":"username","identifier":"invented_user"}]}' } }],
  }) }; };
  const result = await w.extract(run);
  assert.equal(result.ok, false); assert.equal(attempts, 11);
  assert.deepEqual(w.waits, Array(10).fill(2000));
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.entries[0].jobs.length, 0);
  assert.doesNotMatch(pack.entries[0].extractionError, /invented_user|SYNTHETIC_PASSWORD/);
});

test('AI: retries 429 with Retry-After but not invalid credentials', async () => {
  for (const status of [429, 401]) {
    const w = setup(); await w.configure(); const run = await w.create(); let attempts = 0;
    w.ctx.fetch = async () => { attempts++; return { ok: false, status, headers: new Headers({ 'Retry-After': '4' }) }; };
    assert.equal((await w.extract(run)).ok, false);
    assert.equal(attempts, status === 429 ? 11 : 1);
    if (status === 429) assert.ok(w.waits.includes(4000));
  }
});
test('AI: an undetermined login is retried two seconds apart and can recover', async () => {
  const w = setup(); await w.configure(); const run = await w.create(); let attempts = 0;
  w.ctx.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({
    choices: [{ message: { content: JSON.stringify({ accounts: [
      { index: 0, type: 'username', identifier: ++attempts < 4 ? null : 'test_user' },
    ] }) } }],
  }) });
  assert.equal((await w.extract(run)).ok, true);
  assert.equal(attempts, 4); assert.deepEqual(w.waits, [2000,2000,2000]);
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].jobs[0].query.identifier, 'test_user');
});
test('AI: retries send only unresolved rows and preserve an already extracted login', async () => {
  const w = setup(); await w.configure(); const run = await w.create(), inputs = []; let attempts = 0;
  w.ctx.fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    inputs.push(input.map(r => r.value)); attempts++;
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: input.map((row, index) => ({
        index, type: 'username', identifier: attempts === 1 && row.value.startsWith('second:') ? null : row.value.split(':')[0],
      })) }) } }],
    }) };
  };
  assert.equal((await w.extract(run, '42', ['alpha:beta:SYNTHETIC_PASSWORD', 'second:SYNTHETIC_PASSWORD'])).ok, true);
  const jobs = (await w.ctx.db.get('package:' + run.id)).entries[0].jobs;
  assert.deepEqual(jobs.map(j => j.query.identifier), ['alpha', 'second']);
  assert.equal(attempts, 2);
  assert.deepEqual(inputs.map(rows => rows.length), [2,1]);
  assert.equal(inputs[1][0], 'second:SYNTHETIC_PASSWORD');
});

test('AI: bounded concurrency, cancellation blocks queued requests and late saves', async () => {
  const w = setup(); await w.configure(); const run = await w.create(3), pending = [];
  w.ctx.fetch = (url, init) => new Promise(resolve => pending.push({ resolve, init }));
  const running = ['42', '43', '44'].map(bid => w.extract(run, bid));
  for (let i = 0; i < 100 && pending.length < 2; i++) await settle();
  assert.equal(pending.length, 2);
  assert.equal((await w.send({ action: 'ai-cancel', id: run.id, runId: run.runId })).ok, true);
  for (const req of pending) req.resolve({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: '{"accounts":[{"index":0,"type":"username","identifier":"test_user"}]}' } }] }) });
  await Promise.all(running);
  assert.equal(pending.length, 2);
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.ok(pack.entries.every(e => e.jobs.length === 0));
});

test('AI: retries network errors, body timeouts and 5xx with fresh request signals', async () => {
  for (const failure of ['network', 'body', 'server']) {
    const w = setup(); await w.configure(); const run = await w.create();
    const normal = w.ctx.fetch, signals = []; let attempts = 0;
    w.ctx.fetch = async (url, init) => {
      signals.push(init.signal);
      if (++attempts === 1) {
        if (failure === 'network') throw new TypeError('SYNTHETIC_SECRET must not be persisted');
        if (failure === 'server') return { ok: false, status: 503, headers: new Headers() };
        return { ok: true, json: async () => { throw new DOMException('Synthetic body timeout', 'TimeoutError'); } };
      }
      return normal(url, init);
    };
    assert.equal((await w.extract(run)).ok, true);
    assert.equal(attempts, 2); assert.notEqual(signals[0], signals[1]);
  }
});

test('AI: missing account data is a per-entry error and never causes a list fetch', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  assert.equal((await w.extract(run, '42', [])).ok, false);
  assert.equal(w.requests.length, 0);
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].extractionState, 'error');
});

test('AI: changed source status prevents extraction before any paid request', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  w.ctx.chrome.tabs.sendMessage = async () => ({ ok: true, entries: [{ bidId: '42', status: '4' }] });
  assert.equal((await w.extract(run)).ok, false);
  assert.equal(w.requests.length, 0);
});

test('AI: retry preserves completed jobs and their Social Check idempotency keys', async () => {
  const w = setup(); await w.configure(); const first = await w.create();
  assert.equal((await w.extract(first)).ok, true);
  const before = await w.ctx.db.get('package:' + first.id);
  const second = await w.send({ action: 'sc-auto-create', packageId: first.id, entries: [{ bidId: '42' }] });
  assert.equal(second.ok, true);
  assert.equal((await w.extract(second)).ok, true);
  const after = await w.ctx.db.get('package:' + first.id);
  assert.equal(after.entries[0].jobs[0].key, before.entries[0].jobs[0].key);
  assert.equal(w.requests.length, 1);
});

test('AI: cancellation during Retry-After prevents the next HTTP attempt', async () => {
  const w = setup(); await w.configure(); const run = await w.create(), timers = [];
  w.ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  let attempts = 0;
  w.ctx.fetch = async () => { attempts++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '10' }) }; };
  const request = w.extract(run);
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  assert.equal(timers[0].ms, 10000);
  await w.send({ action: 'ai-cancel', id: run.id, runId: run.runId });
  await request; assert.equal(attempts, 1);
});

test('AI: a new run rejects late extraction results from the previous run', async () => {
  const w = setup(); await w.configure(); const run = await w.create(); let release;
  const normal = w.ctx.fetch;
  w.ctx.fetch = async (url, init) => { await new Promise(resolve => { release = resolve; }); return normal(url, init); };
  const request = w.extract(run);
  for (let i = 0; i < 100 && !release; i++) await settle();
  const restarted = await w.send({ action: 'sc-auto-create', packageId: run.id, entries: [{ bidId: '42' }] });
  assert.equal(restarted.ok, true); release(); await request;
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.runId, restarted.runId); assert.equal(pack.entries[0].jobs.length, 0);
});

test('AI: partial extraction can be retried without losing an already completed check', async () => {
  const w = setup(); await w.configure(); const run = await w.create(); let partial = true;
  w.ctx.fetch = async (url, init) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({
    choices: [{ message: { content: JSON.stringify({ accounts:
      JSON.parse(JSON.parse(init.body).messages[1].content).rows.map((row, index) => ({
        index, type: 'username', identifier: partial && row.value.startsWith('test_second:') ? null : row.value.split(':')[0],
      })),
    }) } }],
  }) });
  const rows = ['test_user:SYNTHETIC_PASSWORD', 'test_second:SECOND_SYNTHETIC_PASSWORD'];
  assert.equal((await w.extract(run, '42', rows)).ok, true);
  const before = await w.ctx.db.get('package:' + run.id);
  before.entries[0].jobs[0].check = { id: 'existing-check', status: 'found' };
  await w.ctx.db.set('package:' + run.id, before);
  const restarted = await w.send({ action: 'sc-auto-create', packageId: run.id, entries: [{ bidId: '42' }] });
  assert.equal(restarted.ready.length, 0); partial = false;
  assert.equal((await w.extract(restarted, '42', rows)).ok, true);
  const after = await w.ctx.db.get('package:' + run.id);
  assert.equal(after.entries[0].jobs.length, 2);
  assert.equal(after.entries[0].jobs[0].key, before.entries[0].jobs[0].key);
  assert.equal(after.entries[0].jobs[0].check.id, 'existing-check');
  assert.equal(after.entries[0].extractionIssues.length, 0);
});

test('pipeline: a ready bid can reach Social Check before the other bid finishes extraction', async () => {
  const w = setup(); await w.configure(); const run = await w.create(2); w.connect(run.id);
  const normal = w.ctx.fetch, posts = []; let release;
  w.ctx.fetch = async (url, init) => {
    if (url.startsWith('https://social.example.test/')) {
      posts.push(init);
      return { ok: true, status: 202, headers: new Headers(), json: async () => ({
        id: 'synthetic-check', status: 'pending', query: JSON.parse(init.body),
      }) };
    }
    if (JSON.parse(init.body).messages[1].content.includes('test_second')) await new Promise(resolve => { release = resolve; });
    return normal(url, init);
  };
  const other = w.extract(run, '43', ['test_second:SECOND_SYNTHETIC_PASSWORD']);
  assert.equal((await w.extract(run)).ok, true);
  for (let i = 0; i < 100 && !release; i++) await settle();
  const result = await w.send({ action: 'sc-submit', id: run.id, bidId: '42', job: 0, client: 'client' },
    { url: 'chrome-extension://test/review.html' });
  assert.equal(result.ok, true, result.error);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { platform: 'instagram', identifier_type: 'username', identifier: 'test_user' });
  assert.doesNotMatch(posts[0].body, /SYNTHETIC_PASSWORD/);
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.entries[1].extractionState, 'pending');
  await w.send({ action: 'ai-cancel', id: run.id, runId: run.runId }); release(); await other;
});

test('AI: an email local-part or domain cannot be substituted for a social login', async () => {
  for (const identifier of ['test_user', 'example.test']) {
    const w = setup(); await w.configure(); const run = await w.create();
    w.ctx.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: [{ index: 0, type: 'username', identifier }] }) } }],
    }) });
    assert.equal((await w.extract(run, '42', ['test_user@example.test:SYNTHETIC_PASSWORD'])).ok, false);
    assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].jobs.length, 0);
  }
});

test('all preview: every row is extracted in bounded chunks with no two-account limit', async () => {
  const w = setup(); await w.configure(); const run = await w.create(), sizes = [];
  const rows = Array.from({ length: 23 }, (_, i) => `preview_user_${i}:SYNTHETIC_PASSWORD`);
  w.ctx.fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    sizes.push(input.length);
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: input.map((row, index) => ({
        index, type: 'username', identifier: row.value.split(':')[0],
      })) }) } }],
    }) };
  };
  assert.equal((await w.extract(run, '42', rows)).ok, true);
  const pack = await w.ctx.db.get('package:' + run.id), entry = pack.entries[0];
  assert.equal(entry.jobs.length, 23);
  assert.deepEqual([...sizes].sort((a,b) => a-b), [3,10,10]);
  assert.deepEqual(new Set(entry.jobs.map(j => j.query.identifier)),
    new Set(Array.from({ length: 23 }, (_, i) => `preview_user_${i}`)));
  assert.equal(entry.extractionComplete, true);
  assert.equal(entry.pageRows, 23);
  assert.doesNotMatch(JSON.stringify(pack), /SYNTHETIC_PASSWORD/);
});

test('all preview: retry sends only failed chunks and keeps completed Social Check keys', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  const rows = Array.from({ length: 13 }, (_, i) => `preview_user_${i}:SYNTHETIC_PASSWORD`);
  const inputs = []; let failing = true;
  w.ctx.fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    inputs.push(input.map(r => r.value.split(':')[0]));
    if (failing && input[0].value.startsWith('preview_user_10:')) return { ok: false, status: 503, headers: new Headers() };
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: input.map((row, index) => ({
        index, type: 'username', identifier: row.value.split(':')[0],
      })) }) } }],
    }) };
  };
  assert.equal((await w.extract(run, '42', rows)).ok, false);
  const before = (await w.ctx.db.get('package:' + run.id)).entries[0];
  assert.equal(before.jobs.length, 10); assert.equal(before.extractionComplete, false);
  const restart = await w.send({ action: 'sc-auto-create', packageId: run.id, entries: [{ bidId: '42' }] });
  assert.equal(restart.ready.length, 0);
  failing = false; inputs.length = 0;
  assert.equal((await w.extract(restart, '42', rows)).ok, true);
  assert.deepEqual(inputs, [['preview_user_10', 'preview_user_11', 'preview_user_12']]);
  const after = (await w.ctx.db.get('package:' + run.id)).entries[0];
  assert.equal(after.jobs.length, 13);
  assert.deepEqual(after.jobs.slice(0, 10).map(j => j.key), before.jobs.map(j => j.key));
});

test('all preview: resuming an old two-account package expands it without replacing job keys', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  w.ctx.fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: input.map((row, index) => ({
        index, type: 'username', identifier: row.value.split(':')[0],
      })) }) } }],
    }) };
  };
  const rows = Array.from({ length: 5 }, (_, i) => `preview_user_${i}:SYNTHETIC_PASSWORD`);
  await w.extract(run, '42', rows.slice(0, 2));
  const old = await w.ctx.db.get('package:' + run.id);
  const keys = old.entries[0].jobs.map(j => j.key);
  delete old.previewMode; delete old.entries[0].extractionComplete;
  await w.ctx.db.set('package:' + run.id, old);
  const restart = await w.send({ action: 'sc-auto-create', packageId: run.id, entries: [{ bidId: '42' }] });
  assert.equal(restart.ready.length, 0);
  assert.equal((await w.extract(restart, '42', rows)).ok, true);
  const entry = (await w.ctx.db.get('package:' + run.id)).entries[0];
  assert.equal(entry.jobs.length, 5);
  assert.deepEqual(entry.jobs.slice(0, 2).map(j => j.key), keys);
});

test('all preview: cancellation stops pending chunks within the same bid', async () => {
  const w = setup(); await w.configure(); const run = await w.create(), pending = [];
  w.ctx.fetch = (url, init) => new Promise(resolve => pending.push({ resolve, init }));
  const request = w.extract(run, '42', Array.from({ length: 25 }, (_, i) => `preview_user_${i}:SYNTHETIC_PASSWORD`));
  for (let i = 0; i < 100 && pending.length < 2; i++) await settle();
  assert.equal(pending.length, 2);
  await w.send({ action: 'ai-cancel', id: run.id, runId: run.runId });
  for (const req of pending) req.resolve({ ok: true, json: async () => ({}) });
  assert.equal((await request).ok, false);
  assert.equal(pending.length, 2, 'The third chunk must not be sent after cancellation');
});
