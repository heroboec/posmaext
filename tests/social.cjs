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
  for (const name of ['social-common.js', 'social-store.js', 'social-worker.js']) vm.runInContext(source(name), context);
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
test('one global API queue: GET catalog, POSTs and GET results share persisted 2500ms spacing', async () => {
  const w = worker(); await w.setup(); const id = await w.create();
  await w.send({ action: 'sc-test' }, optionsSender); // invalid catalog body still consumes one request
  await Promise.all([0, 1].map(job => w.send({ action: 'sc-submit', id, bidId: '42', job, client: 'client' })));
  await w.send({ action: 'sc-refresh', id, bidId: '42', job: 0, client: 'client' });
  assert.equal(w.requests.length, 4);
  for (let i = 1; i < w.requests.length; i++) assert.ok(w.requests[i].at - w.requests[i - 1].at >= 2500);
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
  w.context.setTimeout = fn => { close(); queueMicrotask(fn); };
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
    messages.push(msg); return { ok: true, mapping: { Instagram: 'instagram' }, interval: 800, catalog, id: 'synthetic-package' };
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
test('wizard: only single supported filter, first 10 visible fixed, list request not clicks, skip no replacement', async () => {
  const s = content(12);
  try {
    await settle(); assert.equal(s.w.document.querySelector('.pm-filter-social-btn'), null);
    s.w.eval("pmActiveFilters.add('Instagram'); pmApplyFilter(); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    assert.equal(s.requests[0].body.toString(), 'do=list&bid_id=42&order_id=0&mode=0');
    assert.match(s.root().textContent, /1 из 10/);
    s.button('Пропустить').click(); await settle();
    assert.equal(s.requests[1].body.get('bid_id'), '43');
    s.button('Назад').click(); await settle();
    assert.equal(s.requests.length, 2); // Memory cache, not a second-page request.
    s.button('Отмена').click(); assert.equal(s.root(), undefined);
    assert.equal(s.messages.some(m => m.action === 'sc-create'), false);
  } finally { s.w.eval('pmObserver?.disconnect()'); await settle(); s.dom.window.close(); }
});
test('wizard: reject before column choice, cancel restores step, server error retains synthetic reason', async () => {
  const s = content();
  try {
    await settle(); s.w.eval("pmActiveFilters.add('Instagram'); pmRenderFilterPanel();");
    s.w.document.querySelector('.pm-filter-social-btn').click(); await settle();
    s.button('Отклонить заявку').click(); s.root().querySelector('.pm-modal-cancel').click(); await settle();
    assert.match(s.root().textContent, /Заявка #42/);
    s.button('Отклонить заявку').click(); s.root().querySelector('.pm-modal-reason').value = 'SYNTHETIC_REASON';
    s.w.fetch = async () => ({ ok: true, json: async () => ({ code: 5 }) });
    s.root().querySelector('.pm-modal-submit').click(); await settle();
    assert.equal(s.root().querySelector('.pm-modal-reason').value, 'SYNTHETIC_REASON');
    assert.equal(s.w.document.getElementById('status_id42').value, '2');
    s.w.fetch = async () => ({ ok: true, json: async () => ({ code: 0 }) });
    s.root().querySelector('.pm-modal-submit').click(); await settle();
    assert.equal(s.w.document.getElementById('status_id42').value, '4');
    assert.equal(s.root(), undefined);
    assert.equal(s.messages.some(m => m.action === 'sc-create'), false);
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
