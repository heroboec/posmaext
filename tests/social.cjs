const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const { JSDOM } = require('jsdom');
const source = name => fs.readFileSync(path.join(__dirname, '../extension/', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const catalog = [{ platform: 'instagram', object_type: 'profile', operation: 'fetch', identifier_types: ['username'] }];
const example = () => ({ bidId: '42', status: '2', category: 'Instagram', subcategory: 'Synthetic', platform: 'instagram',
  column: 0, type: 'username', pageRows: 3, properties: [{ label: 'Подписчики', value: '10' }], identifiers: ['test_profile_a', 'test_profile_b'] });
const extensionUrl = 'chrome-extension://synthetic/';
const optionsSender = { url: extensionUrl + 'options.html', id: 'synthetic' };
const reviewSender = { url: extensionUrl + 'review.html?id=example', id: 'synthetic' };
const contentSender = { url: 'https://example.test/bids/list', frameId: 0, tab: { id: 7, index: 2 }, id: 'synthetic' };
function worker(indexedDB = new IDBFactory()) {
  let clock = 1000000;
  const requests = [], tabs = [], listeners = {}, ports = [];
  const context = vm.createContext({ indexedDB, crypto: webcrypto, TextEncoder, URL, URLSearchParams, AbortSignal, structuredClone,
    Date: class extends Date { static now() { return clock; } }, setTimeout: fn => { queueMicrotask(fn); },
    chrome: { runtime: { id: 'synthetic', getURL: p => extensionUrl + p,
      onConnect: { addListener: f => { listeners.connect = f; } }, onMessage: { addListener: f => { listeners.message = f; } } },
    permissions: { contains: async () => true }, tabs: {
      create: async tab => { tabs.push(tab); return { id: 8 }; }, get: async id => ({ id, url: contentSender.url }),
      query: async () => [{ id: 7, url: contentSender.url, title: 'Synthetic list' }],
      sendMessage: async (id, msg) => ({ ok: true, status: msg.command === 'accept' ? '3' : '4', entries: [{ bidId: '42', status: '2' }] }),
    } }, fetch: async (url, options) => {
      requests.push({ url, options, at: clock });
      return { ok: true, status: 202, headers: new Headers(), json: async () => ({ id: 'check-1', status: 'pending',
        query: options.body ? JSON.parse(options.body) : { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile_a' } }) };
    }, Headers,
  });
  for (const name of ['social-common.js', 'social-store.js', 'diagnostics.js', 'social-worker.js']) vm.runInContext(source(name), context);
  vm.runInContext('globalThis.api = { scHandle, scBinding, scApi, db: PM_DB, common: PM_SOCIAL };', context);
  // Advance virtual time by the requested wait; no real API or paid calls occur.
  context.setTimeout = (fn, ms) => { clock += ms || 0; queueMicrotask(fn); };
  const send = (msg, sender = reviewSender) => new Promise(resolve => listeners.message(msg, sender, resolve));
  function connect(id, client = 'client') {
    let disconnect;
    const port = { name: 'pm-review:' + id + ':' + client, sender: reviewSender, onDisconnect: { addListener: fn => { disconnect = fn; } } };
    listeners.connect(port); ports.push(port); return () => disconnect();
  }
  async function setup() {
    await send({ action: 'sc-config-save', config: { url: 'https://api.example.test/', key: 'SYNTHETIC_API_KEY', interval: 800, mapping: { Instagram: 'instagram' } } }, optionsSender);
    await context.api.db.set('catalog', catalog);
  }
  async function create(entries = [example()]) {
    const result = await send({ action: 'sc-create', packageId: webcrypto.randomUUID(), entries }, contentSender);
    assert.equal(result.ok, true, result.error); connect(result.id); return result.id;
  }
  return { context, requests, tabs, send, connect, setup, create, indexedDB, advance: ms => { clock += ms; } };
}
test('product response: data only, literal colons, empty columns, no pager evaluation', () => {
  const w = worker(), common = w.context.api.common;
  assert.deepEqual(plain(common.rows({ code: 0, list: [{ data: 'test_a::mail@example.test:TEST_PASSWORD', value: 'DO_NOT_DECODE' }], pager: '<script>throw 1</script>' })), [['test_a', '', 'mail@example.test', 'TEST_PASSWORD']]);
  assert.throws(() => common.rows({ code: 1, list: [] }));
  assert.throws(() => common.rows({ code: 0, list: [{}] }));
});
test('sampling: random without replacement, normalized duplicates, one value, malformed rows excluded', () => {
  const common = worker().context.api.common;
  const rows = [['test_a', 'PASS'], ['TEST_A', 'PASS'], ['@test_a', 'PASS'], ['test_b', 'PASS'], ['test_c', 'PASS'], ['bad'], ['empty', ''], ['bad@example.test', 'PASS']];
  assert.deepEqual(plain(common.sample(rows, 0, 'instagram', 'username', () => 0)), ['test_b', 'test_c']);
  assert.deepEqual(plain(common.sample(rows.slice(0, 3), 0, 'instagram', 'username')), ['test_a']);
  assert.deepEqual(plain(common.sample(rows, 99, 'instagram', 'username')), []);
  assert.equal(common.valid('tiktok', 'id', '123456'), true);
  assert.equal(common.valid('instagram', 'id', '123456'), false);
  assert.deepEqual(plain(common.types([{ ...catalog[0], identifier_types: ['username', 'url'] }], 'instagram')), ['username']);
});
test('settings accept Facebook category mapping without changing other platforms', async () => {
  const w = worker(); await w.setup();
  const mapping = { Instagram: 'instagram', Facebook: 'facebook', Twitter: 'x', TikTok: 'tiktok', Reddit: 'reddit' };
  const result = await w.send({ action: 'sc-config-save', config: { url: 'https://api.example.test/',
    key: 'SYNTHETIC_API_KEY', mapping } }, optionsSender);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(plain((await w.send({ action: 'sc-config-get' }, optionsSender)).mapping), { ...plain(w.context.api.common.defaults), ...mapping });
});
test('default mappings: all eight categories are available before settings are saved', async () => {
  const w = worker();
  const expected = { Instagram: 'instagram', Twitter: 'x', X: 'x', 'x.com(Twitter)': 'x',
    TikTok: 'tiktok', YouTube: 'youtube', Reddit: 'reddit', Facebook: 'facebook' };
  assert.deepEqual(plain((await w.send({ action: 'sc-config-get' }, optionsSender)).mapping), expected);
  assert.deepEqual(plain((await w.send({ action: 'sc-public' }, contentSender)).mapping), expected);
});
test('default mappings: missing categories appear in saved settings without overwriting custom mappings or API binding', async () => {
  const w = worker(); await w.setup();
  const saved = await w.context.api.db.get('config');
  saved.mapping = { Instagram: 'reddit', 'Synthetic category': 'facebook' };
  await w.context.api.db.set('config', saved);
  const before = await w.context.api.scBinding(saved);
  const options = await w.send({ action: 'sc-config-get' }, optionsSender);
  assert.equal(options.mapping.Instagram, 'reddit');
  assert.equal(options.mapping['Synthetic category'], 'facebook');
  assert.equal(options.mapping['x.com(Twitter)'], 'x');
  assert.equal(options.mapping.Facebook, 'facebook');
  assert.deepEqual((await w.send({ action: 'sc-public' }, contentSender)).mapping, options.mapping);
  const stored = await w.context.api.db.get('config');
  assert.deepEqual(stored, saved, 'Reading defaults must not rewrite user settings or secrets');
  assert.equal(await w.context.api.scBinding(stored), before);
});
test('worker protects key/settings and persists only compact selected values with keys BEFORE POST', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  assert.equal((await w.send({ action: 'sc-config-get' }, contentSender)).ok, false);
  assert.equal((await w.send({ action: 'sc-get', id }, contentSender)).ok, false);
  const pub = await w.send({ action: 'sc-public' }, contentSender);
  assert.equal(JSON.stringify(pub).includes('SYNTHETIC_API_KEY'), false);
  const pack = (await w.send({ action: 'sc-get', id })).package;
  assert.ok(pack.entries[0].jobs.every(j => j.key));
  assert.equal(w.requests.length, 0);
  assert.equal(JSON.stringify(pack).includes('password'), false);
  const result = await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(JSON.parse(w.requests[0].options.body), { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile_a' });
  assert.equal(w.requests[0].options.headers['Idempotency-Key'], pack.entries[0].jobs[0].key);
  assert.equal(w.requests[0].options.credentials, 'omit');
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, true);
  assert.equal(w.requests.length, 1);
});
test('Social Check diagnostics preserve the raw error body without exposing the API key or making extra calls', async () => {
  const w = worker(); await w.setup(); const id = await w.create(); let requests = 0;
  w.context.fetch = async () => {
    requests++;
    return { ok: false, status: 400, headers: new Headers(),
      text: async () => '{"error":"SYNTHETIC_REMOTE_DETAIL","key":"SYNTHETIC_API_KEY"}' };
  };
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, false);
  const result = await w.send({ action: 'sc-diagnostics', id, bidId: '42', job: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.social.length, 1);
  assert.equal(result.diagnostics.social[0].status, 400);
  assert.match(result.diagnostics.social[0].body, /SYNTHETIC_REMOTE_DETAIL/);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_API_KEY/);
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify((await w.send({ action: 'sc-get', id })).package), /SYNTHETIC_REMOTE_DETAIL/);
});
test('check retries: ten automatic retries, fixed two-second delay and identical idempotency key', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), requests = [];
  w.context.fetch = async (url, options) => {
    requests.push({ at: w.context.Date.now(), key: options.headers['Idempotency-Key'], query: options.body });
    return { ok: requests.length === 11, status: requests.length === 11 ? 202 : 503, headers: new Headers(),
      json: async () => ({ id: 'synthetic-check', status: 'pending', query: JSON.parse(options.body) }) };
  };
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, true);
  assert.equal(requests.length, 11);
  assert.ok(requests.every(r => r.key === requests[0].key && r.query === requests[0].query));
  assert.deepEqual(requests.slice(1).map((r, i) => r.at - requests[i].at), Array(10).fill(2000));
  const job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.retryCount, 10); assert.equal(job.error, null);
});
test('check retries: persistent network error stops after eleven attempts, not forever', async () => {
  const w = worker(); await w.setup(); const id = await w.create(); let attempts = 0;
  w.context.fetch = async () => { attempts++; throw new TypeError('SYNTHETIC_FAILURE'); };
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, false);
  assert.equal(attempts, 11);
  const job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.requestState, 'failed'); assert.equal(job.attemptCount, 11);
  assert.equal(job.errorKind, 'network'); assert.equal(job.retryable, true);
  assert.equal(w.context.api.common.autoAction(job), null, 'An exhausted cycle must not restart forever');
});
test('delivery progress is durable while HTTP is in flight and during the two-second retry wait', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), pending = [], timers = [];
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  w.context.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, options }));
  const result = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client', manual: false });
  for (let i = 0; i < 100 && !pending.length; i++) await settle();
  let job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.requestState, 'sending'); assert.equal(job.attemptCount, 1);
  pending[0].resolve({ ok: false, status: 503, headers: new Headers(), text: async () => 'SYNTHETIC_SERVER_ERROR' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.requestState, 'retry_wait'); assert.equal(job.lastHttpStatus, 503);
  assert.equal(job.errorKind, 'server'); assert.equal(job.attemptCount, 1);
  assert.equal(job.retryAt - w.context.Date.now(), 2000);
  w.advance(timers[0].ms); timers[0].fn();
  for (let i = 0; i < 100 && pending.length < 2; i++) await settle();
  pending[1].resolve({ ok: true, status: 202, headers: new Headers(), json: async () => ({
    id: 'synthetic-recovered', status: 'pending', query: JSON.parse(pending[1].options.body),
  }) });
  assert.equal((await result).ok, true);
  job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.requestState, 'confirmed'); assert.equal(job.attemptCount, 2);
  assert.equal(job.error, null); assert.equal(job.key, pending[0].options.headers['Idempotency-Key']);
});
test('lost POST response is retried with the same key and recovers the already accepted check', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), accepted = new Map(), keys = [];
  w.context.fetch = async (url, options) => {
    const key = options.headers['Idempotency-Key']; keys.push(key);
    if (!accepted.has(key)) accepted.set(key, { id: 'synthetic-accepted-once', status: 'found', query: JSON.parse(options.body) });
    if (keys.length === 1) throw new TypeError('Synthetic lost response after server acceptance');
    return { ok: true, status: 200, headers: new Headers(), json: async () => accepted.get(key) };
  };
  const result = await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client', manual: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(accepted.size, 1);
  assert.equal((await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0].check.id, 'synthetic-accepted-once');
});
test('a worker restart resumes the remaining attempt budget, never resets the key or loops an exhausted automatic request', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const pack = (await w.send({ action: 'sc-get', id })).package, old = pack.entries[0].jobs[0];
  Object.assign(old, { attempted: true, requestAction: 'sc-submit', requestState: 'sending', attemptCount: 3, retryCount: 2 });
  await w.context.api.db.set('package:' + id, pack);
  const restored = worker(w.indexedDB); restored.connect(id);
  const recovered = (await restored.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(recovered.requestState, 'retry_wait'); assert.equal(recovered.attemptCount, 3);
  const keys = [];
  restored.context.fetch = async (url, options) => { keys.push(options.headers['Idempotency-Key']); throw new TypeError('Synthetic offline'); };
  assert.equal((await restored.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client', manual: false })).ok, false);
  assert.equal(keys.length, 8); assert.ok(keys.every(key => key === old.key));
  const failed = (await restored.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(failed.attemptCount, 11); assert.equal(failed.retryCount, 10);
  await restored.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client', manual: false });
  assert.equal(keys.length, 8, 'No automatic second retry cycle');
  restored.context.fetch = async (url, options) => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ id: 'synthetic-manually-recovered', status: 'found', query: JSON.parse(options.body) }) });
  const manual = await restored.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client', manual: true });
  assert.equal(manual.ok, true, manual.error);
  assert.equal((await restored.send({ action: 'sc-get', id })).package.entries[0].jobs[0].key, old.key);
});
test('an interrupted last attempt is surfaced as exhausted, not a forever-sending job', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const pack = (await w.send({ action: 'sc-get', id })).package;
  Object.assign(pack.entries[0].jobs[0], { attempted: true, requestAction: 'sc-submit', requestState: 'sending', attemptCount: 11, retryCount: 10 });
  await w.context.api.db.set('package:' + id, pack);
  const job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.requestState, 'failed');
  assert.match(job.error, /Лимит попыток исчерпан/);
  assert.equal(w.context.api.common.autoAction(job), null);
  assert.equal(w.requests.length, 0);
});
test('legacy uncertain jobs can resume only known transient errors with a remaining budget', () => {
  const w = worker(), common = w.context.api.common;
  for (const error of [null, 'Сетевой сбой. Результат отправки неизвестен; повтор использует прежний ключ',
    'API вернул некорректный JSON; повтор использует прежний ключ']) {
    const job = { attempted: true, error, retryCount: 2 };
    assert.equal(common.autoAction(job), 'sc-submit');
    assert.equal(common.resumeAttempts(job, 'sc-submit'), 3);
    assert.equal(common.autoAction({ ...job, retryCount: 10 }), null);
  }
  for (const error of ['Недостаточно средств', 'Неверный API-ключ', 'Строка или статус изменились', 'Synthetic unknown failure']) {
    assert.equal(common.autoAction({ attempted: true, error }), null);
  }
  assert.equal(common.autoAction({ attempted: true, requestState: 'paused', requestAction: 'sc-submit' }), null);
});
test('resumed GET recovers an accepted result by its existing ID without any POST', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  const pack = (await w.send({ action: 'sc-get', id })).package, old = pack.entries[0].jobs[0];
  Object.assign(old, { requestAction: 'sc-refresh', requestState: 'sending', attemptCount: 2, retryCount: 1 });
  await w.context.api.db.set('package:' + id, pack);
  const restored = worker(w.indexedDB); restored.connect(id);
  restored.context.fetch = async (url, options) => {
    restored.requests.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.ok(url.endsWith('/checks/' + old.check.id));
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ...old.check, status: 'found' }) };
  };
  const result = await restored.send({ action: 'sc-refresh', id, bidId: '42', job: 0, client: 'client', manual: false });
  assert.equal(result.ok, true, result.error);
  const after = (await restored.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(after.check.status, 'found'); assert.equal(after.attemptCount, 3); assert.equal(after.key, old.key);
  assert.equal(restored.requests.length, 1);
});
test('restoring an uncertain automatic POST still verifies the source status before sending', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const pack = (await w.send({ action: 'sc-get', id })).package;
  pack.auto = true;
  Object.assign(pack.entries[0].jobs[0], { attempted: true, requestAction: 'sc-submit', requestState: 'sending', attemptCount: 1 });
  await w.context.api.db.set('package:' + id, pack);
  w.context.chrome.tabs.sendMessage = async () => ({ ok: true, entries: [{ bidId: '42', status: '4' }] });
  const result = await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client', manual: false });
  assert.equal(result.ok, false);
  assert.equal(w.requests.length, 0);
  const job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.requestState, 'paused'); assert.equal(job.errorKind, 'local');
  assert.equal(w.context.api.common.autoAction(job), null);
});
test('check retries: malformed GET result is retried without another paid POST', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), requests = [];
  await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  w.context.fetch = async (url, options) => {
    requests.push({ method: options.method, at: w.context.Date.now() });
    return { ok: true, status: 200, headers: new Headers(), json: async () => {
      if (requests.length < 3) throw new SyntaxError('Synthetic invalid JSON');
      return { id: 'check-1', status: 'found', query: { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile_a' } };
    } };
  };
  assert.equal((await w.send({ action: 'sc-refresh', id, bidId: '42', job: 0, client: 'client' })).ok, true);
  assert.deepEqual(requests.map(r => r.method), ['GET','GET','GET']);
  assert.equal(requests[1].at - requests[0].at, 2000);
});
test('check retries: closing the requesting review prevents the next retry', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), timers = [];
  const close = w.connect(id, 'stopper'); let attempts = 0;
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  w.context.fetch = async () => { attempts++; throw new TypeError('SYNTHETIC_FAILURE'); };
  const request = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'stopper' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  assert.equal(timers[0]?.ms, 2000);
  close(); w.advance(timers[0].ms); timers[0].fn();
  assert.equal((await request).ok, false); assert.equal(attempts, 1);
});
test('check retries: permanent credentials, balance and parameter errors do not loop', async () => {
  for (const status of [400,401,402,403,404,409]) {
    const w = worker(); await w.setup(); const id = await w.create(); let attempts = 0;
    w.context.fetch = async () => { attempts++; return { ok: false, status, headers: new Headers() }; };
    assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, false);
    assert.equal(attempts, 1);
  }
});
test('check retries: changing store settings during a delay prevents sending to the new server', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), timers = []; let attempts = 0;
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  w.context.fetch = async () => { attempts++; throw new TypeError('SYNTHETIC_FAILURE'); };
  const request = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  await w.send({ action: 'sc-config-save', config: { url: 'https://other.example.test/', key: 'OTHER_TEST_KEY', mapping: {} } }, optionsSender);
  w.advance(timers[0].ms); timers[0].fn();
  assert.equal((await request).ok, false); assert.equal(attempts, 1);
});
test('API starts checks 350 ms apart without waiting for responses and merges reverse results without losing siblings', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const pending = [];
  w.context.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, options, at: w.context.Date.now() }));
  const first = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  const second = w.send({ action: 'sc-submit', id, bidId: '42', job: 1, client: 'client' });
  for (let i = 0; i < 100 && pending.length < 2; i++) await settle();
  assert.equal(pending.length, 2, 'Both HTTP requests must start while neither response has arrived');
  assert.equal(pending[1].at - pending[0].at, 350, 'Shared three requests/s cap, responses may remain concurrent');
  const duplicate = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  await settle(); assert.equal(pending.length, 2, 'Concurrent duplicate must share the existing request');
  assert.equal((await w.send({ action: 'sc-sync', id })).ok, true);
  const response = index => ({ ok: true, status: 202, headers: new Headers(), json: async () => ({
    id: 'check-' + index, status: 'pending', query: JSON.parse(pending[index].options.body) }) });
  pending[1].resolve(response(1)); assert.equal((await second).ok, true);
  pending[0].resolve(response(0)); assert.equal((await first).ok, true); assert.equal((await duplicate).ok, true);
  const pack = (await w.send({ action: 'sc-get', id })).package;
  assert.deepEqual(pack.entries[0].jobs.map(j => j.check.id), ['check-0', 'check-1']);
  assert.equal(pack.entries[0].sourceStatus, '2');
});
test('one FIFO rate limit covers mixed POST, GET and catalog requests: never more than three starts per second', async () => {
  const w = worker(); await w.setup();
  const firstId = await w.create(), secondId = await w.create();
  const starts = [];
  w.context.fetch = async (url, options) => {
    starts.push({ at: w.context.Date.now(), method: options.method, url });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true }) };
  };
  const calls = Array.from({ length: 18 }, (_, i) => w.context.api.scApi(
    i % 3 === 0 ? 'checks' : i % 3 === 1 ? 'checks/synthetic-check' : 'platforms',
    { owner: (i % 2 ? firstId : secondId) + ':client',
      ...(i % 3 === 0 ? { method: 'POST', key: 'synthetic-' + i,
        query: { platform: 'facebook', identifier_type: 'id', identifier: String(100 + i) } } : {}) }));
  await Promise.all(calls);
  assert.equal(starts.length, 18);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 1].at >= 350);
  for (let i = 3; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 3].at >= 1050);
  assert.deepEqual(starts.map(r => r.method), Array.from({ length: 18 }, (_, i) => i % 3 === 0 ? 'POST' : 'GET'));
});
test('rate limiter persists its next slot across worker restart', async () => {
  const w = worker(); await w.setup(); await w.context.api.scApi('platforms');
  const first = w.requests[0].at;
  const restored = worker(w.indexedDB);
  await restored.context.api.scApi('platforms');
  assert.ok(restored.requests[0].at - first >= 350);
});
test('sustained mixed traffic respects both sliding windows with scheduling margin', async () => {
  const w = worker(); await w.setup();
  await Promise.all(Array.from({ length: 620 }, (_, i) => w.context.api.scApi(i % 2 ? 'checks/synthetic' : 'platforms')));
  const starts = w.requests.map(r => r.at);
  assert.equal(starts.length, 620);
  for (let i = 3; i < starts.length; i++) assert.ok(starts[i] - starts[i - 3] >= 1050);
  for (let i = 300; i < starts.length; i++) assert.ok(starts[i] - starts[i - 300] >= 60000);
  const rate = await w.context.api.db.get('api-rate');
  assert.ok(rate.starts.length <= 300);
  assert.deepEqual(Object.keys(rate).sort(), ['next', 'starts']);
});
test('rolling minute admission survives restart even if previous starts were faster', async () => {
  const w = worker(); await w.setup();
  const now = w.context.Date.now();
  await w.context.api.db.set('api-rate', { next: now, starts: Array.from({ length: 300 }, (_, i) => now - 10000 + i) });
  const restored = worker(w.indexedDB);
  await restored.context.api.scApi('platforms');
  assert.ok(restored.requests[0].at >= now + 50000, 'Must not reset the minute counter on worker restart');
});
test('automatic polling waits ten seconds per accepted job, including across restart; manual GET remains available', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  const job = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[0];
  assert.equal(job.nextPollAt, w.context.Date.now() + 10000);
  const restored = worker(w.indexedDB); restored.connect(id);
  assert.equal(restored.context.api.common.autoAction(job), null);
  assert.equal((await restored.send({ action: 'sc-refresh', id, bidId: '42', job: 0, client: 'client', manual: false })).ok, true);
  assert.equal(restored.requests.length, 0);
  restored.advance(10000);
  assert.equal(restored.context.api.common.autoAction(job), 'sc-refresh');
  assert.equal((await restored.send({ action: 'sc-refresh', id, bidId: '42', job: 0, client: 'client', manual: false })).ok, true);
  assert.equal(restored.requests.length, 1);
  assert.equal((await restored.send({ action: 'sc-refresh', id, bidId: '42', job: 0, client: 'client' })).ok, true);
  assert.equal(restored.requests.length, 2);
});
test('429 without Retry-After pauses for one minute, exposes countdown, then resumes the same POST', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), starts = [], timers = [];
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  w.context.fetch = async (url, options) => {
    starts.push({ at: w.context.Date.now(), options });
    return starts.length === 1 ? { ok: false, status: 429, headers: new Headers() } :
      { ok: true, status: 202, headers: new Headers(), json: async () => ({
        id: 'synthetic-recovered', status: 'found', query: JSON.parse(options.body),
      }) };
  };
  const request = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  const result = await w.send({ action: 'sc-get', id });
  assert.equal(result.apiQueue.reason, 'rate_limit');
  assert.equal(result.apiQueue.resumeAt - w.context.Date.now(), 60000);
  assert.equal(result.package.entries[0].jobs[0].requestState, 'retry_wait');
  assert.equal(starts.length, 1);
  const timer = timers.shift(); w.advance(timer.ms); timer.fn();
  assert.equal((await request).ok, true);
  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 60000);
  assert.equal(starts[0].options.body, starts[1].options.body);
  assert.equal(starts[0].options.headers['Idempotency-Key'], starts[1].options.headers['Idempotency-Key']);
});
test('a queued job has not spent an attempt and closing its page cancels it before HTTP', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), pending = [], timers = [];
  const closeQueued = w.connect(id, 'queued-client');
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  w.context.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, options }));
  const first = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  for (let i = 0; i < 100 && !pending.length; i++) await settle();
  const second = w.send({ action: 'sc-submit', id, bidId: '42', job: 1, client: 'queued-client' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  const queued = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[1];
  assert.equal(queued.requestState, 'queued'); assert.equal(queued.attemptCount, 0);
  assert.equal(pending.length, 1);
  closeQueued(); w.advance(timers[0].ms); timers[0].fn();
  assert.equal((await second).ok, false); assert.equal(pending.length, 1);
  const stopped = (await w.send({ action: 'sc-get', id })).package.entries[0].jobs[1];
  assert.equal(stopped.requestState, 'paused'); assert.equal(stopped.attemptCount, 0);
  pending[0].resolve({ ok: true, status: 202, headers: new Headers(), json: async () => ({
    id: 'synthetic-first', status: 'pending', query: JSON.parse(pending[0].options.body),
  }) });
  assert.equal((await first).ok, true);
});
test('checking the catalog does not hold the state lock and deadlock queued job admission', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), pending = [], starts = [], timers = [];
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  w.context.fetch = (url, options) => {
    starts.push({ at: w.context.Date.now(), url });
    if (url.endsWith('/platforms')) return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ platforms: catalog }) });
    return new Promise(resolve => pending.push({ resolve, options }));
  };
  const a = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  for (let i = 0; i < 100 && !pending.length; i++) await settle();
  const b = w.send({ action: 'sc-submit', id, bidId: '42', job: 1, client: 'client' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  let result;
  const connection = w.send({ action: 'sc-test' }, optionsSender).then(value => { result = value; });
  for (let i = 0; i < 100 && !result; i++) {
    await settle();
    const timer = timers.shift();
    if (timer) { w.advance(timer.ms); timer.fn(); }
  }
  assert.equal(result?.ok, true, 'Catalog must finish even while both POST responses are pending');
  assert.equal(pending.length, 2); assert.equal(starts.length, 3);
  assert.ok(starts[1].at - starts[0].at >= 200); assert.ok(starts[2].at - starts[1].at >= 200);
  for (const [i, p] of pending.entries()) p.resolve({ ok: true, status: 202, headers: new Headers(),
    json: async () => ({ id: 'synthetic-' + i, status: 'pending', query: JSON.parse(p.options.body) }) });
  await Promise.all([a, b, connection]);
});
test('connection progress remains readable during a persisted cooldown after restart, without HTTP or secrets', async () => {
  const first = worker(); await first.setup();
  const next = first.context.Date.now() + 60000;
  await first.context.api.db.set('api-limit', { next, failures: 1, reason: 'rate_limit' });
  const w = worker(first.indexedDB), timers = [];
  w.context.setTimeout = (fn, ms) => timers.push({ fn, ms });
  w.context.fetch = async () => {
    w.requests.push({ at: w.context.Date.now() });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ platforms: catalog }) };
  };
  const request = w.send({ action: 'sc-test' }, optionsSender);
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  const status = await w.send({ action: 'sc-test-status' }, optionsSender);
  assert.equal(status.ok, true);
  assert.equal(status.test.stage, 'cooldown');
  assert.equal(status.test.waitUntil, next);
  assert.equal(w.requests.length, 0);
  assert.equal(JSON.stringify(status).includes('SYNTHETIC_API_KEY'), false);
  assert.equal(JSON.stringify(status).includes('api.example.test'), false);
  assert.equal((await w.send({ action: 'sc-test-status' }, contentSender)).ok, false);
  assert.equal((await w.send({ action: 'sc-test-status' }, reviewSender)).ok, false);
  const timer = timers.shift(); w.advance(timer.ms); timer.fn();
  assert.equal((await request).ok, true);
  assert.equal(w.requests.length, 1);
  assert.equal((await w.send({ action: 'sc-test-status' }, optionsSender)).test.stage, 'done');
});
test('connection failure reports the HTTP stage even when the exception is caught and the console is silent', async () => {
  const w = worker(); await w.setup(); let rejectFetch;
  w.context.fetch = () => new Promise((resolve, reject) => { rejectFetch = reject; });
  const request = w.send({ action: 'sc-test' }, optionsSender);
  for (let i = 0; i < 100 && !rejectFetch; i++) await settle();
  assert.equal((await w.send({ action: 'sc-test-status' }, optionsSender)).test.stage, 'response');
  rejectFetch(Object.assign(new Error('Synthetic timeout'), { name: 'TimeoutError' }));
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'response');
  assert.match(result.error, /Нет ответа/);
  assert.equal((await w.send({ action: 'sc-test-status' }, optionsSender)).test.stage, 'failed');
});
test('connection status bypasses the state lock while a test is still waiting to start', async () => {
  const w = worker(); await w.setup(); let release;
  const get = w.context.api.db.get; let blocked = false;
  w.context.api.db.get = async key => {
    if (blocked) return get(key);
    blocked = true;
    return new Promise(resolve => { release = resolve; });
  };
  const request = w.send({ action: 'sc-test' }, optionsSender);
  for (let i = 0; i < 100 && !release; i++) await settle();
  const result = await w.send({ action: 'sc-test-status' }, optionsSender);
  assert.equal(result.ok, true);
  assert.equal(result.test.stage, 'config');
  assert.equal(w.requests.length, 0);
  // Complete the blocked config read with no key; no HTTP will be sent.
  release(undefined);
  assert.equal((await request).ok, false);
});
test('a catalog response from the previous store is discarded if settings change during its request', async () => {
  const w = worker(); await w.setup(); let release;
  w.context.fetch = () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ platforms: catalog }) }); });
  const connection = w.send({ action: 'sc-test' }, optionsSender);
  for (let i = 0; i < 100 && !release; i++) await settle();
  await w.send({ action: 'sc-config-save', config: { url: 'https://other.example.test/', key: 'OTHER_TEST_KEY', mapping: {} } }, optionsSender);
  release();
  assert.equal((await connection).ok, false);
  assert.equal(await w.context.api.db.get('catalog'), undefined);
});
test('deleting a package during an API request does not resurrect it on completion', async () => {
  const w = worker(); await w.setup(); const id = await w.create(); let release;
  w.context.fetch = (url, options) => new Promise(resolve => { release = () => resolve({ ok: true, status: 202, headers: new Headers(),
    json: async () => ({ id: 'synthetic-check', status: 'pending', query: JSON.parse(options.body) }) }); });
  const request = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.equal(typeof release, 'function', 'HTTP must already be in flight before deletion');
  assert.equal((await w.send({ action: 'sc-delete', id })).ok, true);
  release(); await request;
  assert.equal((await w.send({ action: 'sc-get', id })).ok, false);
  assert.equal((await w.send({ action: 'sc-list' })).packages.length, 0);
});
test('deleting a package during cooldown prevents its still-unsent paid POST', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), timers = [];
  await w.context.api.db.set('api-limit', { next: w.context.Date.now() + 12000, failures: 1 });
  w.context.setTimeout = (fn, ms) => { if (ms > 0) timers.push({ fn, ms }); else queueMicrotask(fn); };
  const request = w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' });
  for (let i = 0; i < 100 && !timers.length; i++) await settle();
  assert.equal(timers.length, 1);
  assert.equal((await w.send({ action: 'sc-delete', id })).ok, true);
  w.advance(timers[0].ms); timers[0].fn();
  assert.equal((await request).ok, false);
  assert.equal(w.requests.length, 0, 'Deleted packages must not initiate paid requests');
});
test('successful recovery resets failures before the next independent error', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const request = { method: 'POST', key: 'synthetic-key',
    query: { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile_a' } };
  let status = 500;
  w.context.fetch = async (url, options) => ({ ok: status === 202, status, headers: new Headers(),
    json: async () => ({ id: 'synthetic-check', status: 'pending', query: JSON.parse(options.body) }) });
  await assert.rejects(w.context.api.scApi('checks', request), { httpStatus: 500 });
  status = 202;
  await w.context.api.scApi('checks', request);
  assert.equal((await w.context.api.db.get('api-limit')).failures, 0);
  status = 500;
  await assert.rejects(w.context.api.scApi('checks', request), { httpStatus: 500 });
  const limit = await w.context.api.db.get('api-limit');
  assert.equal(limit.failures, 1);
  assert.equal(limit.next - w.context.Date.now(), 2000);
});
test('a concurrent successful response does not erase another requests Retry-After', async () => {
  const w = worker(); await w.setup(); const id = await w.create(), pending = [];
  w.context.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, options }));
  const request = { method: 'POST', key: 'synthetic-key',
    query: { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile_a' } };
  const first = w.context.api.scApi('checks', request);
  const second = w.context.api.scApi('checks', request);
  for (let i = 0; i < 100 && pending.length < 2; i++) await settle();
  assert.equal(pending.length, 2);
  pending[0].resolve({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '12' }) });
  await assert.rejects(first, { httpStatus: 429 });
  const limit = await w.context.api.db.get('api-limit');
  pending[1].resolve({ ok: true, status: 202, headers: new Headers(), json: async () => ({
    id: 'synthetic-check', status: 'pending', query: JSON.parse(pending[1].options.body) }) });
  await second;
  assert.equal((await w.context.api.db.get('api-limit')).next, limit.next);
  assert.ok(limit.next - w.context.Date.now() >= 12000);
});
test('uncertain POST survives worker restart, retries same key/query; changed store blocks old packages', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const pack = (await w.send({ action: 'sc-get', id })).package;
  w.context.fetch = async () => { throw new Error('synthetic transport failure'); };
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, false);
  const restored = worker(w.indexedDB); restored.connect(id);
  assert.equal((await restored.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, true);
  assert.equal(restored.requests[0].options.headers['Idempotency-Key'], pack.entries[0].jobs[0].key);
  await restored.send({ action: 'sc-config-save', config: { url: 'https://different.example.test/', key: 'OTHER_SYNTHETIC_KEY', mapping: {} } }, optionsSender);
  assert.equal((await restored.send({ action: 'sc-submit', id, bidId: '42', job: 1, client: 'client' })).ok, false);
  assert.equal(restored.requests.length, 1);
  assert.equal((await restored.send({ action: 'sc-get', id })).sameStore, false);
});
test('429 honors Retry-After; auth/balance errors pause without a fresh idempotency key', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const at = [];
  w.context.fetch = async () => {
    at.push(w.context.Date.now()); return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '12' }) };
  };
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, false);
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 1, client: 'client' })).ok, false);
  assert.ok(at[1] - at[0] >= 12000);
  for (const status of [401, 402, 403]) {
    w.context.fetch = async () => ({ ok: false, status, headers: new Headers() });
    assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'client' })).ok, false);
  }
  const pack = (await w.send({ action: 'sc-get', id })).package;
  assert.ok(pack.entries[0].jobs[0].error);
  assert.equal(pack.entries[0].jobs[0].rejected, undefined);
});
test('closing one review stops its waiting request even while another review remains open', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  const close = w.connect(id, 'closing'); w.connect(id, 'other');
  await w.context.api.db.set('api-rate', { next: w.context.Date.now() + 200 });
  w.context.setTimeout = (fn, ms) => { close(); w.advance(ms || 0); queueMicrotask(fn); };
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'closing' })).ok, false);
  assert.equal(w.requests.length, 0);
  assert.equal((await w.send({ action: 'sc-submit', id, bidId: '42', job: 0, client: 'other' })).ok, true);
});
test('manual decisions: origin, eligible status, package membership; closed tab never receives blind requests', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  assert.equal((await w.send({ action: 'sc-decision', id, bidId: '99', decision: 'accept' })).ok, false);
  w.context.chrome.tabs.get = async () => ({ url: 'https://other.example.test/bids' });
  assert.equal((await w.send({ action: 'sc-decision', id, bidId: '42', decision: 'accept' })).ok, false);
  w.context.chrome.tabs.get = async () => { throw new Error('closed'); };
  assert.equal((await w.send({ action: 'sc-decision', id, bidId: '42', decision: 'accept' })).ok, false);
  w.context.chrome.tabs.get = async () => ({ url: contentSender.url });
  assert.equal((await w.send({ action: 'sc-decision', id, bidId: '42', decision: 'accept' })).ok, true);
  assert.equal((await w.send({ action: 'sc-get', id })).package.entries[0].status, '3');
  assert.equal((await w.send({ action: 'sc-decision', id, bidId: '42', decision: 'accept' })).ok, false);
  assert.equal((await w.send({ action: 'sc-decision', id, bidId: '42', decision: 'decline', message: 'SYNTHETIC_REASON' })).ok, true);
});
test('compact draft survives reload and excludes passwords/raw rows; create retry preserves check keys', async () => {
  const w = worker(); await w.setup();
  const entry = example(), packageId = webcrypto.randomUUID();
  const item = { ...entry, selection: { column: entry.column, type: entry.type, identifiers: entry.identifiers, pageRows: entry.pageRows }, rows: [['test_a', 'SYNTHETIC_PASSWORD']] };
  assert.equal((await w.send({ action: 'sc-draft-save', packageId, items: [item], index: 0 }, contentSender)).ok, true);
  const draft = (await w.send({ action: 'sc-draft-get' }, contentSender)).draft;
  assert.equal(JSON.stringify(draft).includes('SYNTHETIC_PASSWORD'), false);
  assert.deepEqual(plain(draft.items[0].selection.identifiers), entry.identifiers);
  await w.send({ action: 'sc-create', packageId, entries: [entry] }, contentSender);
  const first = (await w.send({ action: 'sc-get', id: packageId })).package;
  await w.send({ action: 'sc-create', packageId, entries: [entry] }, contentSender);
  const second = (await w.send({ action: 'sc-get', id: packageId })).package;
  assert.equal(first.entries[0].jobs[0].key, second.entries[0].jobs[0].key);
  assert.equal((await w.send({ action: 'sc-list' })).packages.length, 1);
});
function content(count = 1) {
  const row = id => `<tr class="bids-tr-table-new"><td><a data-bid-id-show-section="${id}"></a><div data-section-category><span>Instagram</span></div><select id="status_id${id}" data-current-status="2"><option value="2">Review</option><option value="3">Sale</option><option value="4">Declined</option></select></td></tr><tr class="tr-hidden-bid"><td><div class="bid-macro-display-row"><span>Подписчики</span><div class="section-bids-item"><div class="field-view">10</div></div></div></td></tr>`;
  const dom = new JSDOM(`<meta name="csrf-token" content="SYNTHETIC_CSRF"><table>${Array.from({ length: count }, (_, i) => row(42 + i)).join('')}</table>`, { url: contentSender.url, runScripts: 'dangerously' });
  const w = dom.window, messages = [], requests = [];
  w.AbortSignal = AbortSignal;
  w.chrome = { runtime: { id: 'synthetic', onMessage: { addListener: fn => { w.sourceListener = fn; } }, sendMessage: async msg => {
    messages.push(msg); return { ok: true, mapping: { Instagram: 'instagram' }, interval: 800, catalog, aiConcurrency: 10, id: 'synthetic-package' };
  } }, storage: { local: { get: (_, cb) => cb({ urlPatterns: ['/bids'] }) }, onChanged: { addListener() {} } } };
  w.fetch = async (url, options) => {
    requests.push({ url, body: new URLSearchParams(options.body.toString()) });
    return { ok: true, json: async () => ({ code: 0, list: [{ data: 'test_a:SYNTHETIC_PASSWORD:a@example.test:MAIL_PASSWORD' }] }) };
  };
  w.setTimeout = (fn) => { queueMicrotask(fn); return 1; };
  w.alert = text => { w.lastAlert = text; };
  w.confirm = () => true;
  for (const name of ['rejection-reasons.js', 'social-common.js', 'content.js', 'social-content.js']) {
    const script = w.document.createElement('script'); script.textContent = source(name); w.document.head.append(script);
  }
  const root = () => w.document.querySelector('.pm-modal-backdrop')?.shadowRoot;
  const button = text => [...root().querySelectorAll('button')].find(b => b.textContent === text);
  return { dom, w, requests, messages, root, button };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
test('manual source preview reads only the requested bid, verifies membership/status and never fetches', async () => {
  const s = content(2);
  try {
    await settle();
    for (const id of [42, 43]) s.w.document.getElementById('status_id' + id).closest('tr').querySelector('td')
      .insertAdjacentHTML('beforeend', `<div class="section-accounts-js-${id}"><span data-account-full="synthetic_${id}:SYNTHETIC_PASSWORD">short</span></div>`);
    const send = extra => new Promise(resolve => s.w.sourceListener({ action: 'sc-source', command: 'account-preview',
      origin: new URL(contentSender.url).origin, entries: [{ bidId: '42', status: '2' }], bidId: '42', status: '2', ...extra },
    { id: 'synthetic' }, resolve));
    const result = await send({});
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(Array.from(result.rows), ['synthetic_42:SYNTHETIC_PASSWORD']);
    assert.equal((await send({ bidId: '43' })).ok, false);
    s.w.document.getElementById('status_id42').value = '3';
    assert.equal((await send({})).ok, false);
    assert.equal(s.requests.length, 0);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('launch button: Instagram remains visible and explains a missing catalog or mapping', async () => {
  const s = content();
  try {
    await settle();
    s.w.eval("pmActiveFilters.add('Instagram'); pmSocialConfig.catalog = []; pmRenderFilterPanel();");
    let btn = s.w.document.querySelector('.pm-filter-social-btn');
    assert.ok(btn);
    assert.equal(btn.disabled, true);
    assert.match(s.w.document.querySelector('.pm-social-hint').textContent, /Проверить связь/);
    s.w.eval("pmSocialConfig.catalog = " + JSON.stringify(catalog) + "; pmRenderFilterPanel();");
    assert.equal(s.w.document.querySelector('.pm-filter-social-btn').disabled, false);
    s.w.eval("pmSocialConfig.mapping = {}; pmRenderFilterPanel();");
    btn = s.w.document.querySelector('.pm-filter-social-btn');
    assert.ok(btn);
    assert.equal(btn.disabled, true);
    assert.match(s.w.document.querySelector('.pm-social-hint').textContent, /Instagram/);
    assert.match(s.w.document.querySelector('.pm-social-hint').textContent, /сопоставление/i);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('launch button: background connection errors are visible and focus retry recovers', async () => {
  const s = content();
  try {
    await settle();
    s.w.eval("pmActiveFilters.add('Instagram')");
    const send = s.w.chrome.runtime.sendMessage;
    s.w.chrome.runtime.sendMessage = async msg => msg.action === 'sc-public'
      ? { ok: false, error: 'SYNTHETIC_CONNECTION_FAILURE' } : send(msg);
    s.w.dispatchEvent(new s.w.Event('focus')); await settle();
    assert.ok(s.w.document.querySelector('.pm-filter-social-btn'));
    assert.equal(s.w.document.querySelector('.pm-filter-social-btn').disabled, true);
    assert.match(s.w.document.querySelector('.pm-social-hint').textContent, /SYNTHETIC_CONNECTION_FAILURE/);
    s.w.chrome.runtime.sendMessage = send;
    s.w.dispatchEvent(new s.w.Event('focus')); await settle();
    assert.equal(s.w.document.querySelector('.pm-filter-social-btn').disabled, false);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('automation: all visible filtered bids use full DOM accounts with bounded concurrency and no ten-bid limit', async () => {
  const s = content(16), pending = [];
  try {
    await settle(); assert.equal(s.w.document.querySelector('.pm-filter-social-btn').disabled, true);
    for (let id = 42; id < 58; id++) {
      const tr = s.w.document.getElementById('status_id' + id).closest('tr');
      tr.querySelector('td').insertAdjacentHTML('beforeend', `<div class="bids-item-title">Synthetic title ${id}</div>
        <div class="section-accounts-js-${id}"><span data-account-full="test_${id}:SYNTHETIC_SECRET">short…</span></div>`);
    }
    s.w.document.getElementById('status_id52').closest('tr').hidden = true;
    s.w.document.getElementById('status_id53').closest('tr').style.display = 'none';
    s.w.document.getElementById('status_id54').closest('tr').querySelector('[data-section-category] span').textContent = 'Twitter';
    const send = s.w.chrome.runtime.sendMessage;
    s.w.chrome.runtime.sendMessage = msg => {
      if (msg.action === 'ai-extract') { s.messages.push(msg); return new Promise(resolve => pending.push({ msg, resolve })); }
      return send(msg);
    };
    s.w.eval("pmActiveFilters.add('Instagram'); pmApplyFilter(); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    assert.equal(s.requests.length, 0);
    assert.equal(pending.length, 10);
    assert.deepEqual(pending.map(p => p.msg.bidId), ['42','43','44','45','46','47','48','49','50','51']);
    assert.ok(pending.every(p => p.msg.rows[0] === `test_${p.msg.bidId}:SYNTHETIC_SECRET`));
    const create = s.messages.find(m => m.action === 'sc-auto-create');
    assert.deepEqual(Array.from(create.entries, e => e.bidId), ['42','43','44','45','46','47','48','49','50','51','55','56','57']);
    assert.doesNotMatch(JSON.stringify(create), /SYNTHETIC_SECRET/);
    assert.equal(s.root().querySelector('[data-column]'), null);
    for (const p of pending.slice().reverse()) p.resolve({ ok: true, count: 1 });
    await settle();
    assert.deepEqual(pending.slice(10).map(p => p.msg.bidId), ['55','56','57']);
    for (const p of pending.slice(10)) p.resolve({ ok: true, count: 1 });
    await settle(); assert.equal(s.root(), undefined);
    assert.equal(s.w.eval('pmBusy'), null);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('automation: scoped format and description, missing format still passes title and row', async () => {
  const s = content(2);
  try {
    await settle();
    const first = s.w.document.getElementById('status_id42').closest('tr');
    first.querySelector('td').insertAdjacentHTML('beforeend', '<div class="bids-item-title">Synthetic A</div><span data-text-item="42">Synthetic description A</span><div class="section-accounts-js-42"><span data-account-full="user_a:TEST_PASSWORD">short</span></div>');
    first.nextElementSibling.querySelector('td').insertAdjacentHTML('beforeend', '<div class="bid-macro-display-row"><span>Формат: </span><div class="section-bids-item"><div class="field-view">login:password</div></div></div>');
    s.w.eval("pmActiveFilters.add('Instagram'); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    const entries = s.messages.find(m => m.action === 'sc-auto-create').entries;
    assert.equal(entries[0].title, 'Synthetic A');
    assert.equal(entries[0].description, 'Synthetic description A');
    assert.equal(entries[0].format, 'login:password');
    assert.equal(entries[1].format, '');
    assert.equal(s.requests.length, 0);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('automation: every full account in the preview is sent, not a random pair', async () => {
  const s = content();
  try {
    await settle();
    const tr = s.w.document.getElementById('status_id42').closest('tr');
    tr.querySelector('td').insertAdjacentHTML('beforeend', `<div class="section-accounts-js-42">
      ${Array.from({ length: 7 }, (_, i) => `<span data-account-full="preview_user_${i}:SYNTHETIC_PASSWORD">short…</span>`).join('')}
    </div>`);
    s.w.eval("pmActiveFilters.add('Instagram'); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    const sent = s.messages.find(m => m.action === 'ai-extract');
    assert.equal(sent.pageRows, 7);
    // The runtime releases transient raw strings after receiving a response; capture
    // them at the messaging boundary in the second run.
    const send = s.w.chrome.runtime.sendMessage, copies = [];
    s.w.chrome.runtime.sendMessage = msg => {
      if (msg.action === 'ai-extract') copies.push(Array.from(msg.rows));
      return send(msg);
    };
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    assert.deepEqual(copies[0], Array.from({ length: 7 }, (_, i) => `preview_user_${i}:SYNTHETIC_PASSWORD`));
    assert.equal(s.requests.length, 0);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('automation: cancellation tells worker to stop and ignores late replies', async () => {
  const s = content();
  try {
    await settle(); let release;
    const send = s.w.chrome.runtime.sendMessage;
    s.w.chrome.runtime.sendMessage = msg => msg.action === 'ai-extract'
      ? new Promise(resolve => { release = resolve; }) : send(msg);
    s.w.eval("pmActiveFilters.add('Instagram'); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    s.button('Отмена').click();
    assert.ok(s.messages.some(m => m.action === 'ai-cancel'));
    release({ ok: true, count: 1 }); await settle();
    assert.equal(s.root(), undefined);
    assert.equal(s.requests.length, 0);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('automation: bounded content queue does not read or send later bids after cancellation', async () => {
  const s = content(4), pending = [];
  try {
    await settle(); const send = s.w.chrome.runtime.sendMessage;
    s.w.chrome.runtime.sendMessage = async msg => {
      if (msg.action === 'ai-extract') { s.messages.push(msg); return new Promise(resolve => pending.push(resolve)); }
      const result = await send(msg);
      return msg.action === 'sc-public' ? { ...result, aiConcurrency: 2 } : result;
    };
    s.w.eval("pmActiveFilters.add('Instagram'); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    assert.equal(pending.length, 2);
    s.button('Отмена').click();
    for (const resolve of pending) resolve({ ok: true, count: 1 });
    await settle();
    assert.equal(s.messages.filter(m => m.action === 'ai-extract').length, 2);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('manual status timeout is never automatically retried', async () => {
  const s = content();
  try {
    await settle(); let attempts = 0;
    s.w.fetch = async () => { attempts++; throw new s.w.DOMException('Synthetic timeout', 'TimeoutError'); };
    await assert.rejects(s.w.eval("pmSocialChange({bidId:'42',status:'2'}, '3')"), { name: 'TimeoutError' });
    assert.equal(attempts, 1);
    assert.equal(s.w.document.getElementById('status_id42').value, '2');
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('source decisions: strict success, status rechecked after delay, native change not dispatched', async () => {
  const s = content();
  try {
    await settle();
    s.w.fetch = async () => ({ ok: true, json: async () => ({ unexpected: true }) });
    await assert.rejects(s.w.eval("pmSocialChange({bidId:'42',status:'2'}, '3')"), /не подтвердил/);
    assert.equal(s.w.document.getElementById('status_id42').value, '2');
    s.w.setTimeout = fn => { s.w.document.getElementById('status_id42').value = '4'; queueMicrotask(fn); };
    let calls = 0; s.w.fetch = async () => { calls++; return { ok: true, json: async () => ({ code: 0 }) }; };
    await assert.rejects(s.w.eval("pmSocialChange({bidId:'42',status:'2'}, '3')"), /Статус изменился/);
    assert.equal(calls, 0);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
