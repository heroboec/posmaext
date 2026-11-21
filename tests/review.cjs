const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const file = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function review(jobs, failSubmit = false, extra = {}) {
  const pack = { id: 'synthetic', auto: !!extra.auto, tabId: 7, entries: [{ bidId: '42', status: '2', category: 'Instagram', subcategory: 'Synthetic',
    column: 0, type: 'username', pageRows: 20, properties: [{ label: 'Подписчики', value: '100' }, { label: 'Непроверяемое свойство', value: 'Synthetic' }], jobs, ...extra.entry }] };
  const dom = new JSDOM(file('review.html'), { url: 'https://extension.example.test/review.html?id=synthetic', runScripts: 'dangerously' });
  const w = dom.window, messages = [];
  const intervals = [];
  w.setInterval = fn => { intervals.push(fn); return 1; };
  w.chrome = { runtime: { connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }), sendMessage: async msg => {
    messages.push(msg);
    if (msg.action === 'sc-list') return { ok: true, packages: [] };
    if (msg.action === 'sc-get') return { ok: true, package: structuredClone(pack), sameStore: true };
    if (msg.action === 'sc-diagnostics') return { ok: true, diagnostics: extra.diagnostics || { available: false, rowChoices: [], rows: [], ai: [], social: [] } };
    if (msg.action === 'ai-manual-preview') return { ok: true, rows: [{ index: 1, value: 'mail@example.test|manual_profile|SYNTHETIC_PASSWORD' },
      { index: 2, value: 'mail@example.test||SYNTHETIC_PASSWORD' }], digest: 'synthetic-digest', runId: 'synthetic-run', types: ['username'], platform: 'instagram' };
    if (msg.action === 'ai-manual-apply') return { ok: true, added: 1, remaining: 1 };
    if (msg.action === 'sc-submit' && failSubmit) return { ok: false, error: 'Synthetic pause' };
    return { ok: true };
  } }, storage: { local: { get: (_, cb) => cb({}) }, onChanged: { addListener() {} } } };
  for (const name of ['rejection-reasons.js', 'social-common.js', 'content.js', 'review-diagnostics.js', 'review-manual.js', 'review.js']) {
    const script = w.document.createElement('script'); script.textContent = file(name); w.document.head.append(script);
  }
  await settle(); return { w, dom, messages, pack, intervals };
}
const job = status => ({ query: { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile' }, key: 'synthetic-key',
  check: { id: 'synthetic-check', status, query: {}, result: { data: { followers: 0, bio: null } } } });
test('account table keeps login in each row and omits avatar, link, name and bio', async () => {
  const profile = job('found');
  Object.assign(profile.check.result.data, { avatar_url: 'https://example.test/avatar', profile_url: 'https://example.test/profile',
    display_name: 'Synthetic name', username: 'synthetic_name', external_id: '123', registration_date: '2020-05-17' });
  const s = await review([profile]);
  try {
    const table = s.w.document.querySelector('.accounts-table');
    assert.deepEqual([...table.querySelectorAll('th')].map(n => n.textContent),
      ['Логин / ID', 'Состояние', 'ID', 'Регистрация', 'Публикации', 'Друзья', 'Подписчики', 'Подписки', 'Подробности / ошибка']);
    const cells = [...table.querySelector('tbody tr').children].map(n => n.textContent);
    assert.equal(cells[0], 'test_profile'); assert.equal(cells[2], '123');
    assert.equal(cells[3], '2020-05-17');
  } finally { s.dom.window.close(); }
});
test('automatic review submits ready logins, renders description and never auto-retries an uncertain POST', async () => {
  const j = { query: job('pending').query, key: 'synthetic-key', attempted: true, error: 'Synthetic network error' };
  const s = await review([j], false, { auto: true, entry: { title: 'Synthetic title', description: 'Synthetic multiline\ndescription' } });
  try {
    assert.match(s.w.document.querySelector('.description').textContent, /Synthetic multiline/);
    assert.match(s.w.document.querySelector('.accounts-table tbody tr').textContent, /test_profile/);
    assert.equal(s.messages.some(m => m.action === 'sc-submit'), false);
    s.pack.entries[0].jobs.push({ query: { ...j.query, identifier: 'second_profile' }, key: 'second-key' });
    await s.intervals[0](); await settle();
    const submits = s.messages.filter(m => m.action === 'sc-submit');
    assert.equal(submits.length, 1);
    assert.equal(submits[0].job, 1);
    assert.equal(submits[0].manual, false);
  } finally { s.dom.window.close(); }
});
test('review renders horizontal rows, 0 vs null and unavailable without claiming absence', async () => {
  const s = await review([job('unavailable')]);
  try {
    const table = s.w.document.querySelector('article table');
    assert.equal(table.querySelectorAll('tbody tr').length, 1);
    const cells = [...table.querySelector('tbody tr').children].map(n => n.textContent);
    assert.equal(cells[6], '0'); assert.equal(cells[3], 'Нет данных');
    assert.match(cells[1], /Недоступно \(не означает отсутствие\)/);
    assert.doesNotMatch(s.w.document.querySelector('article').textContent, /Непроверяемое свойство|Исходные свойства поставщика/);
    assert.equal(s.w.document.querySelector('pre'), null);
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-submit').length, 0);
  } finally { s.dom.window.close(); }
});
test('review dispatches the batch concurrently, reports errors and does not issue fresh paid retries', async () => {
  const pendingJob = { query: job('pending').query, key: 'synthetic-key' };
  const s = await review([pendingJob, { ...pendingJob, key: 'synthetic-key-2' }]);
  try {
    const send = s.w.chrome.runtime.sendMessage, pending = [];
    s.w.chrome.runtime.sendMessage = msg => msg.action === 'sc-submit'
      ? new Promise(resolve => pending.push(resolve)) : send(msg);
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(pending.length, 2, 'Send the second job before the first responds');
    pending[0]({ ok: false, error: 'Synthetic pause' }); await settle();
    assert.equal(s.w.document.getElementById('check').disabled, true, 'Wait for already-sent jobs even after one fails');
    pending[1]({ ok: true }); await settle();
    assert.match(s.w.document.getElementById('notice').textContent, /Очередь приостановлена/);
    assert.equal(s.w.document.getElementById('check').disabled, false);
  } finally { s.dom.window.close(); }
});
test('each account occupies its own row; supplier properties table is removed', async () => {
  const first = job('found'), second = job('found');
  first.query.identifier = 'synthetic_first'; first.check.result.data.followers = 120;
  second.query.identifier = 'synthetic_second'; second.check.result.data.followers = 5;
  const s = await review([first, second]);
  try {
    const rows = [...s.w.document.querySelectorAll('.accounts-table tbody tr')];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(tr => [tr.children[0].textContent, tr.children[6].textContent]),
      [['synthetic_first', '120'], ['synthetic_second', '5']]);
    const supplierRows = [...s.w.document.querySelectorAll('article > table tr')];
    assert.equal(supplierRows.length, 0);
    assert.equal(s.w.document.querySelectorAll('article > .scroll').length, 1);
  } finally { s.dom.window.close(); }
});
test('manual chooser: offered for unresolved automatic bids, previews columns, cancels without changes', async () => {
  const s = await review([job('found')], false, { auto: true, entry: { extractionState: 'ready', extractionIssues: ['Строка 2: логин не определён'] } });
  try {
    s.w.document.querySelector('.pm-manual-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-modal-backdrop').shadowRoot;
    assert.match(root.textContent, /manual_profile/);
    assert.equal(root.querySelector('.pm-manual-apply').disabled, true);
    const delimiter = root.querySelector('.pm-manual-delimiter');
    delimiter.value = '|'; delimiter.dispatchEvent(new s.w.Event('change'));
    const column = root.querySelector('.pm-manual-column');
    column.value = '1'; column.dispatchEvent(new s.w.Event('change'));
    assert.equal(root.querySelector('.pm-manual-apply').disabled, false);
    assert.match(root.textContent, /Корректных значений: 1; останутся нераспознанными: 1/);
    await s.intervals[0](); await settle();
    assert.equal(s.w.document.querySelector('.pm-modal-backdrop').shadowRoot, root);
    root.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(s.w.document.querySelector('.pm-modal-backdrop'), null);
    assert.equal(s.messages.some(m => m.action === 'ai-manual-apply'), false);
  } finally { s.dom.window.close(); }
});
test('manual chooser: applying sends only the selection, never raw rows or new paid requests', async () => {
  const s = await review([], false, { auto: true, entry: { extractionState: 'error', extractionError: 'Synthetic unresolved login' } });
  try {
    s.w.document.querySelector('.pm-manual-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-modal-backdrop').shadowRoot;
    const delimiter = root.querySelector('.pm-manual-delimiter'); delimiter.value = '|'; delimiter.dispatchEvent(new s.w.Event('change'));
    const column = root.querySelector('.pm-manual-column'); column.value = '1'; column.dispatchEvent(new s.w.Event('change'));
    root.querySelector('.pm-manual-apply').click(); await settle();
    const msg = s.messages.find(m => m.action === 'ai-manual-apply');
    assert.equal(msg.bidId, '42'); assert.equal(msg.column, 1); assert.equal(msg.delimiter, '|');
    assert.equal(msg.digest, 'synthetic-digest');
    assert.doesNotMatch(JSON.stringify(msg), /SYNTHETIC_PASSWORD|manual_profile|mail@example/);
    assert.equal(s.w.document.querySelector('.pm-modal-backdrop'), null);
    assert.equal(s.messages.some(m => ['ai-extract', 'sc-submit', 'sc-refresh'].includes(m.action)), false);
  } finally { s.dom.window.close(); }
});
test('manual chooser: hidden for successful/pending or non-automatic bids', async () => {
  for (const extra of [{ auto: true, entry: { extractionState: 'ready' } },
    { auto: true, entry: { extractionState: 'pending', extractionError: 'Synthetic error' } }, {}]) {
    const s = await review([job('found')], false, extra);
    try { assert.equal(s.w.document.querySelector('.pm-manual-open'), null); }
    finally { s.dom.window.close(); }
  }
});
test('manual chooser: profile URL stays in one colon-delimited column; auto type is offered and sent', async () => {
  const s = await review([], false, { auto: true, entry: { extractionState: 'error', extractionError: 'Synthetic unresolved login' } });
  try {
    const send = s.w.chrome.runtime.sendMessage;
    s.w.chrome.runtime.sendMessage = async msg => {
      if (msg.action !== 'ai-manual-preview') return send(msg);
      s.messages.push(msg);
      return { ok: true, rows: [{ index: 0, value: 'https://facebook.com/profile.php?id=123456:SYNTHETIC_PASSWORD' }],
        digest: 'synthetic-digest', runId: 'synthetic-run', types: ['username', 'id'], platform: 'facebook' };
    };
    s.w.document.querySelector('.pm-manual-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-modal-backdrop').shadowRoot;
    assert.equal(root.querySelector('.pm-manual-type').value, 'auto');
    assert.deepEqual([...root.querySelectorAll('thead th')].map(n => n.textContent), ['Исходная строка', 'Столбец 1', 'Столбец 2']);
    assert.equal(root.querySelector('tbody td:nth-child(2)').textContent, 'https://facebook.com/profile.php?id=123456');
    const column = root.querySelector('.pm-manual-column'); column.value = '0'; column.dispatchEvent(new s.w.Event('change'));
    assert.equal(root.querySelector('.pm-manual-apply').disabled, false);
    root.querySelector('.pm-manual-apply').click(); await settle();
    const msg = s.messages.find(m => m.action === 'ai-manual-apply');
    assert.equal(msg.type, 'auto'); assert.equal(msg.column, 0);
    assert.doesNotMatch(JSON.stringify(msg), /SYNTHETIC_PASSWORD|123456/);
  } finally { s.dom.window.close(); }
});
test('diagnostics window is optional, renders source and responses as text and makes no paid requests', async () => {
  const s = await review([job('failed')], false, { diagnostics: {
    available: true, rowChoices: [{ id: 1, index: 0, time: 1000 }],
    rows: [{ id: 1, index: 0, time: 1000, value: 'test_profile:SYNTHETIC_PASSWORD' }],
    ai: [{ id: 2, attempt: 1, method: 'POST', endpoint: 'https://ai.example.test/v1/chat/completions',
      time: 1000, ended: 1500, status: 502, error: 'Synthetic gateway failure', body: '<script>window.executed=true</script>' }],
    social: [{ id: 3, attempt: 2, method: 'POST', endpoint: 'https://api.example.test/api/v1/checks',
      time: 2000, status: 500, body: '{"error":"SYNTHETIC_SERVICE_ERROR"}' }],
  } });
  try {
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), null);
    assert.doesNotMatch(s.w.document.getElementById('entries').textContent, /SYNTHETIC_PASSWORD/);
    s.w.document.querySelector('.pm-diagnostics-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-diagnostics-backdrop').shadowRoot;
    assert.match(root.textContent, /test_profile:SYNTHETIC_PASSWORD/);
    assert.match(root.textContent, /Synthetic gateway failure/);
    assert.match(root.textContent, /SYNTHETIC_SERVICE_ERROR/);
    assert.equal(root.querySelector('script'), null); assert.equal(s.w.executed, undefined);
    root.querySelector('.pm-diagnostics-refresh').click(); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-diagnostics').length, 2);
    assert.equal(s.messages.filter(m => ['sc-submit','sc-refresh','ai-extract'].includes(m.action)).length, 0);
    root.querySelector('.pm-diagnostics-close').click();
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), null);
    s.w.document.querySelector('.pm-diagnostics-open').click(); await settle();
    const again = s.w.document.querySelector('.pm-diagnostics-backdrop').shadowRoot;
    again.querySelector('.pm-diagnostics-select').value = 'row:1';
    again.querySelector('.pm-diagnostics-select').dispatchEvent(new s.w.Event('change')); await settle();
    assert.equal(s.messages.at(-1).rowId, 1);
    again.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), null);
  } finally { s.dom.window.close(); }
});
test('an open diagnostics window survives result redraws and does not pause automatic checks', async () => {
  const s = await review([job('found')], false, { auto: true, entry: { extractionState: 'pending' } });
  try {
    s.w.document.querySelector('.pm-diagnostics-open').click(); await settle();
    const modal = s.w.document.querySelector('.pm-diagnostics-backdrop');
    s.pack.auto = true;
    s.pack.entries[0].jobs.push({ query: { ...job('found').query, identifier: 'new_profile' }, key: 'new-key' });
    await s.intervals[0](); await settle();
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), modal);
    assert.equal(s.messages.filter(m => m.action === 'sc-submit').length, 1);
    assert.equal(s.messages.some(m => m.action === 'ai-cancel'), false);
  } finally { s.dom.window.close(); }
});
