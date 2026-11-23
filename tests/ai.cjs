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
  let clock = Date.now();
  let connectListener;
  const ctx = vm.createContext({
    indexedDB: new IDBFactory(), crypto: webcrypto, TextEncoder, URL, AbortController, AbortSignal, DOMException,
    Date: class extends Date { static now() { return clock; } }, Headers,
    setTimeout: (fn, ms) => { waits.push(ms); clock += ms || 0; queueMicrotask(fn); }, clearTimeout() {},
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
test('diagnostics: the exact system prompt sent to the model is available for inspection', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  assert.equal((await w.extract(run)).ok, true);
  const sent = JSON.parse(w.requests[0].init.body).messages.find(m => m.role === 'system').content;
  assert.match(sent, /supplier format is only a fallible hint/);
  assert.match(sent, /Field order is another weak clue/);
  assert.match(sent, /Contradictory data overrides this ordering hint/);
  assert.match(sent, /Analyze each row independently/);
  assert.match(sent, /Do not split blindly on every colon/);
  assert.match(sent, /merged label is not a reason to shift columns/);
  assert.match(sent, /two ambiguous secret-like tokens are not sufficient evidence/);
  const result = await w.send({ action: 'sc-diagnostics', id: run.id, bidId: '42' }, { url: 'chrome-extension://test/review.html' });
  assert.equal(result.diagnostics.ai[0].request.systemPrompt, sent);
  assert.doesNotMatch(JSON.stringify(result), /AI_TEST_KEY|SOCIAL_TEST_KEY/);
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

test('AI: malformed identifier gets three retries two seconds apart without echoing secrets', async () => {
  const w = setup(); await w.configure(); const run = await w.create(); let attempts = 0;
  w.ctx.fetch = async () => { attempts++; return { ok: true, status: 200, headers: new Headers(), json: async () => ({
    choices: [{ message: { content: '{"accounts":[{"index":0,"type":"username","identifier":"invented_user"}]}' } }],
  }) }; };
  const result = await w.extract(run);
  assert.equal(result.ok, false); assert.equal(attempts, 4);
  assert.deepEqual(w.waits, Array(3).fill(2000));
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.entries[0].jobs.length, 0);
  assert.doesNotMatch(pack.entries[0].extractionError, /invented_user|SYNTHETIC_PASSWORD/);
});

test('AI: retries 429 with Retry-After but not invalid credentials', async () => {
  for (const status of [429, 401]) {
    const w = setup(); await w.configure(); const run = await w.create(); let attempts = 0;
    w.ctx.fetch = async () => { attempts++; return { ok: false, status, headers: new Headers({ 'Retry-After': '4' }) }; };
    assert.equal((await w.extract(run)).ok, false);
    assert.equal(attempts, status === 429 ? 4 : 1);
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
test('pipeline: a resolved login reaches Social Check while another row in the SAME AI chunk is still retrying', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  let modelCalls = 0, release, input;
  w.ctx.fetch = async (url, init) => {
    if (!url.includes('chat/completions')) return { ok: true, status: 200, headers: new Headers(),
      json: async () => ({ id: 'synthetic-early-check', status: 'found', query: JSON.parse(init.body) }) };
    modelCalls++;
    input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    if (modelCalls === 1) return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: [
        { index: 0, type: 'username', identifier: 'test_user' }, { index: 1, type: 'username', identifier: null },
      ] }) } }],
    }) };
    return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        accounts: [{ index: 0, type: 'username', identifier: 'second_user' }],
      }) } }] }) }); });
  };
  const extracting = w.extract(run, '42', ['test_user:SYNTHETIC_PASSWORD', 'second_user:SYNTHETIC_PASSWORD']);
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.equal(typeof release, 'function');
  const partial = (await w.ctx.db.get('package:' + run.id)).entries[0];
  assert.equal(partial.extractionState, 'pending');
  assert.equal(partial.jobs.length, 1); assert.equal(partial.jobs[0].query.identifier, 'test_user');
  assert.deepEqual(Array.from(input, row => row.value), ['second_user:SYNTHETIC_PASSWORD']);
  w.connect(run.id);
  const checked = await w.send({ action: 'sc-submit', id: run.id, bidId: '42', job: 0, client: 'client', manual: false }, reviewPage);
  assert.equal(checked.ok, true, checked.error);
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].jobs[0].check.id, 'synthetic-early-check');
  release(); assert.equal((await extracting).ok, true);
  const done = (await w.ctx.db.get('package:' + run.id)).entries[0];
  assert.equal(done.jobs.length, 2); assert.equal(done.jobs[0].key, partial.jobs[0].key);
  assert.equal(done.jobs[0].check.id, 'synthetic-early-check');
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

const reviewPage = { url: 'chrome-extension://test/review.html' };
async function manualFixture() {
  const w = setup(); await w.configure(); const run = await w.create();
  const rows = ['test_user:SYNTHETIC_PASSWORD', 'mail@example.test:manual_profile:SYNTHETIC_PASSWORD',
    'mail@example.test:manual_profile:SYNTHETIC_PASSWORD_2', 'mail@example.test::SYNTHETIC_PASSWORD'];
  // A partial, completed extraction: only row 0 was confidently resolved.
  w.ctx.fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: input.map((row, index) => ({
        index, type: 'username', identifier: row.value.startsWith('test_user:') ? 'test_user' : null,
      })) }) } }],
    }) };
  };
  assert.equal((await w.extract(run, '42', rows)).ok, true);
  w.ctx.chrome.tabs.sendMessage = async (tab, msg) => {
    assert.equal(tab, 7);
    if (msg.command === 'account-preview') {
      assert.equal(msg.bidId, '42'); assert.equal(msg.status, '2');
      return { ok: true, rows, pageRows: rows.length };
    }
    return { ok: true, entries: [{ bidId: '42', status: '2' }] };
  };
  const preview = () => w.send({ action: 'ai-manual-preview', id: run.id, bidId: '42' }, reviewPage);
  const apply = (snapshot, extra = {}) => w.send({ action: 'ai-manual-apply', id: run.id, bidId: '42',
    digest: snapshot.digest, runId: snapshot.runId, delimiter: ':', column: 1, type: 'username', ...extra }, reviewPage);
  return { w, run, rows, preview, apply };
}
test('manual column: only unresolved rows, unique jobs, original checks/keys preserved and no paid requests', async () => {
  const { w, run, preview, apply } = await manualFixture();
  const pack = await w.ctx.db.get('package:' + run.id);
  pack.entries[0].jobs[0].check = { id: 'synthetic-check', status: 'found' };
  await w.ctx.db.set('package:' + run.id, pack);
  w.ctx.fetch = () => { throw new Error('Manual selection must not call a paid API'); };
  const snapshot = await preview();
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.deepEqual(Array.from(snapshot.rows, r => r.index), [1, 2, 3]);
  const saved = await apply(snapshot); assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.added, 1); assert.equal(saved.remaining, 1);
  const after = await w.ctx.db.get('package:' + run.id), entry = after.entries[0];
  assert.deepEqual(entry.jobs[0], pack.entries[0].jobs[0]);
  assert.equal(entry.jobs[1].query.identifier, 'manual_profile');
  assert.equal(entry.extractionIssues.length, 1);
  assert.equal(entry.extractedIndexes.length, 3);
  assert.doesNotMatch(JSON.stringify(after), /SYNTHETIC_PASSWORD|mail@example\.test/);
  const again = await apply(snapshot);
  assert.equal(again.ok, false, 'Only an invalid unresolved row remains; no jobs should be added');
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].jobs[1].key, entry.jobs[1].key);
});
test('manual column: trusted review only; bad type/column/delimiter and stale data rejected', async () => {
  const { w, run, rows, preview, apply } = await manualFixture();
  for (const sender of [source, options]) {
    assert.equal((await w.send({ action: 'ai-manual-preview', id: run.id, bidId: '42' }, sender)).ok, false);
    assert.equal((await w.send({ action: 'ai-manual-apply', id: run.id, bidId: '42' }, sender)).ok, false);
  }
  assert.equal((await w.send({ action: 'ai-manual-preview', id: run.id, bidId: '999' }, reviewPage)).ok, false);
  const snapshot = await preview();
  for (const extra of [{ type: 'id' }, { column: -1 }, { column: 1.5 }, { delimiter: '' },
    { column: 0 }, { digest: 'changed' }, { runId: 'old-run' }]) {
    assert.equal((await apply(snapshot, extra)).ok, false, JSON.stringify(extra));
  }
  rows[1] = 'mail@example.test:changed_profile:SYNTHETIC_PASSWORD';
  assert.equal((await apply(snapshot)).ok, false);
  assert.equal((await preview()).ok, false);
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].jobs.length, 1);
});
test('manual column: paused queue remains paused; unavailable source or changed store blocks changes', async () => {
  const { w, run, preview, apply } = await manualFixture();
  await w.send({ action: 'ai-cancel', id: run.id }, reviewPage);
  const snapshot = await preview();
  assert.equal((await apply(snapshot)).ok, true);
  assert.equal((await w.ctx.db.get('package:' + run.id)).aiPaused, true);
  w.ctx.chrome.tabs.sendMessage = async () => ({ ok: false, error: 'Synthetic source status changed' });
  assert.equal((await preview()).ok, false);
  await w.send({ action: 'sc-config-save', config: { url: 'https://changed.example.test/', key: 'SYNTHETIC_OTHER_KEY', mapping: { Instagram: 'instagram' } } }, options);
  assert.equal((await apply(snapshot)).ok, false);
});
test('manual column: a new extraction run or concurrent resolution cannot overwrite current jobs', async () => {
  const { w, run, preview, apply } = await manualFixture();
  const snapshot = await preview();
  const pack = await w.ctx.db.get('package:' + run.id);
  pack.runId = 'synthetic-new-run';
  await w.ctx.db.set('package:' + run.id, pack);
  assert.equal((await apply(snapshot)).ok, false);
  pack.runId = snapshot.runId; pack.entries[0].extractionState = 'pending';
  await w.ctx.db.set('package:' + run.id, pack);
  assert.equal((await preview()).ok, false);
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries[0].jobs.length, 1);
});
test('automatic packages accept more than ten bids and retry retains their order', async () => {
  const w = setup(); await w.configure(); const run = await w.create(24);
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.entries.length, 24);
  assert.deepEqual(pack.entries.map(e => e.bidId), Array.from({ length: 24 }, (_, i) => String(42 + i)));
  const retry = await w.send({ action: 'sc-auto-create', packageId: run.id, entries: pack.entries });
  assert.equal(retry.ok, true, retry.error);
  assert.equal((await w.ctx.db.get('package:' + run.id)).entries.length, 24);
});
test('manual column: a fully failed bid can be recovered after worker diagnostic memory was lost', async () => {
  const w = setup(); await w.configure(); const run = await w.create();
  w.ctx.fetch = async () => ({ ok: false, status: 401, headers: new Headers() });
  assert.equal((await w.extract(run, '42', ['mail@example.test;recovered_user;SYNTHETIC_PASSWORD'])).ok, false);
  vm.runInContext('PM_DIAG.clear()', w.ctx);
  w.ctx.chrome.tabs.sendMessage = async () => ({ ok: true, rows: ['mail@example.test;recovered_user;SYNTHETIC_PASSWORD'] });
  const snapshot = await w.send({ action: 'ai-manual-preview', id: run.id, bidId: '42' }, reviewPage);
  assert.equal(snapshot.ok, true, snapshot.error);
  const result = await w.send({ action: 'ai-manual-apply', id: run.id, bidId: '42', digest: snapshot.digest,
    runId: snapshot.runId, delimiter: ';', column: 1, type: 'username' }, reviewPage);
  assert.equal(result.ok, true, result.error); assert.equal(result.added, 1); assert.equal(result.remaining, 0);
  const pack = await w.ctx.db.get('package:' + run.id);
  assert.equal(pack.entries[0].extractionComplete, true);
  assert.equal(pack.entries[0].extractionError, '');
  assert.equal(pack.entries[0].jobs[0].query.identifier, 'recovered_user');
});
test('AI: handles, numeric IDs and exact profile URLs produce canonical jobs for every requested platform', () => {
  const w = setup(); vm.runInContext('globalThis.parseProfile = aiParse;', w.ctx);
  const cases = [
    ['instagram', 'username', 'https://instagram.com/Demo.Profile/', 'demo.profile', 'username'],
    ['facebook', 'username', 'Demo.Profile', 'demo.profile', 'username'],
    ['facebook', 'id', '123456', '123456', 'id'],
    ['facebook', 'url', 'https://facebook.com/profile.php?id=123456', '123456', 'id'],
    ['facebook', 'username', 'https://facebook.com/Demo.Profile', 'demo.profile', 'username'],
    ['x', 'username', 'https://twitter.com/demo_profile', 'demo_profile', 'username'],
    ['tiktok', 'id', '123456', '123456', 'id'],
    ['tiktok', 'username', 'https://tiktok.com/@demo.profile', 'demo.profile', 'username'],
    ['reddit', 'username', 'https://reddit.com/user/demo_profile', 'demo_profile', 'username'],
  ];
  for (const [platform, type, value, identifier, kind] of cases) {
    const parsed = w.ctx.parseProfile({ choices: [{ message: { content: JSON.stringify({
      accounts: [{ index: 0, type, identifier: value }],
    }) } }] }, [value + ':SYNTHETIC_PASSWORD'], platform, ['username', 'id']);
    assert.equal(parsed.jobs[0].query.identifier, identifier, value);
    assert.equal(parsed.jobs[0].query.identifier_type, kind, value);
    assert.doesNotMatch(JSON.stringify(parsed), /SYNTHETIC_PASSWORD/);
  }
});
test('AI: a model cannot launder wrong-domain/post URLs into plausible usernames or invent a profile URL', () => {
  const w = setup(); vm.runInContext('globalThis.parseProfile = aiParse;', w.ctx);
  const cases = [
    ['instagram', 'https://evil.example/demo.profile', 'demo.profile'],
    ['instagram', 'https://instagram.com/p/demo.profile', 'demo.profile'],
    ['facebook', 'https://facebook.com/groups/123456', '123456'],
    ['facebook', 'https://facebook.com/profile.php?id=123456&token=SYNTHETIC', '123456'],
    ['facebook', '{"name":"ds_user_id","value":"123456"}', '123456'],
    ['facebook', 'ds_user_id=123456', '123456'],
    ['x', 'https://x.com/demo_profile/status/123', 'demo_profile'],
    ['reddit', 'https://reddit.com/r/demo_profile', 'demo_profile'],
    ['instagram', 'https://evil.example/demo.profile', 'https://instagram.com/demo.profile'],
    ['facebook', 'https://facebook.com/profile.php?id=987654', 'https://facebook.com/profile.php?id=123456'],
  ];
  for (const [platform, row, value] of cases) {
    assert.throws(() => w.ctx.parseProfile({ choices: [{ message: { content: JSON.stringify({
      accounts: [{ index: 0, type: 'username', identifier: value }],
    }) } }] }, [row + ':SYNTHETIC_PASSWORD'], platform, ['username', 'id']), row);
  }
});
test('Facebook pipeline: links and plain identifiers deduplicate, POST uses canonical query and accepts canonical API responses', async () => {
  const w = setup(); await w.configure();
  await w.ctx.db.set('catalog', [{ platform: 'facebook', object_type: 'profile', operation: 'fetch', identifier_types: ['username', 'id', 'url'] }]);
  const run = await w.send({ action: 'sc-auto-create', packageId: webcrypto.randomUUID(),
    entries: [{ bidId: '42', status: '2', platform: 'facebook', category: 'Facebook', properties: [] }] });
  assert.equal(run.ok, true, run.error);
  const values = ['Demo.Profile', 'https://www.facebook.com/Demo.Profile', '123456', 'https://facebook.com/profile.php?id=123456'];
  w.ctx.fetch = async (url, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).rows;
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ message: { content: JSON.stringify({ accounts: input.map((row, index) => ({
        index, type: 'username', identifier: values[index],
      })) }) } }],
    }) };
  };
  assert.equal((await w.extract(run, '42', values.map(value => value + ':SYNTHETIC_PASSWORD'))).ok, true);
  const pack = await w.ctx.db.get('package:' + run.id), jobs = pack.entries[0].jobs;
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => j.query), [
    { platform: 'facebook', identifier_type: 'username', identifier: 'demo.profile' },
    { platform: 'facebook', identifier_type: 'id', identifier: '123456' },
  ]);
  const requests = [];
  w.ctx.fetch = async (url, init) => {
    const query = JSON.parse(init.body); requests.push({ query, key: init.headers['Idempotency-Key'] });
    return { ok: true, status: 202, headers: new Headers(), json: async () => ({ id: 'synthetic-' + query.identifier,
      status: 'pending', query }) };
  };
  w.connect(run.id);
  for (let job = 0; job < 2; job++) {
    const result = await w.send({ action: 'sc-submit', id: run.id, bidId: '42', job, client: 'client' }, reviewPage);
    assert.equal(result.ok, true, result.error);
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.query), jobs.map(j => j.query));
  assert.deepEqual(requests.map(r => r.key), jobs.map(j => j.key));
  const after = await w.ctx.db.get('package:' + run.id);
  assert.ok(after.entries[0].jobs.every(j => j.check?.id));
  assert.doesNotMatch(JSON.stringify(after), /SYNTHETIC_PASSWORD|https:\/\/(?:www\.)?facebook\.com/);
  const diagnostic = await w.send({ action: 'sc-diagnostics', id: run.id, bidId: '42', job: 0 }, reviewPage);
  assert.equal(diagnostic.diagnostics.rows.length, 2, 'Canonical login diagnostics include both the handle and its URL source');
});
test('manual Facebook selection supports mixed links/IDs, deduplicates them and skips email and non-profile links', async () => {
  const w = setup(); await w.configure();
  await w.ctx.db.set('catalog', [{ platform: 'facebook', object_type: 'profile', operation: 'fetch', identifier_types: ['username', 'id', 'url'] }]);
  const run = await w.send({ action: 'sc-auto-create', packageId: webcrypto.randomUUID(),
    entries: [{ bidId: '42', status: '2', platform: 'facebook', category: 'Facebook', properties: [] }] });
  const rows = ['https://facebook.com/Demo.Profile:SYNTHETIC_PASSWORD', '123456:SYNTHETIC_PASSWORD',
    'https://facebook.com/profile.php?id=123456:SYNTHETIC_PASSWORD',
    'https://facebook.com/groups/123:SYNTHETIC_PASSWORD', 'mail@example.test:SYNTHETIC_PASSWORD'];
  w.ctx.fetch = async () => ({ ok: false, status: 401, headers: new Headers() });
  await w.extract(run, '42', rows);
  w.ctx.chrome.tabs.sendMessage = async () => ({ ok: true, rows });
  const preview = await w.send({ action: 'ai-manual-preview', id: run.id, bidId: '42' }, reviewPage);
  const result = await w.send({ action: 'ai-manual-apply', id: run.id, bidId: '42', digest: preview.digest,
    runId: preview.runId, delimiter: ':', column: 0, type: 'auto' }, reviewPage);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.added, 2); assert.equal(result.remaining, 2);
  const entry = (await w.ctx.db.get('package:' + run.id)).entries[0];
  assert.deepEqual(entry.jobs.map(j => j.query.identifier_type), ['username', 'id']);
  assert.doesNotMatch(JSON.stringify(entry), /SYNTHETIC_PASSWORD|mail@example/);
});
