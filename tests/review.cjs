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
    if (msg.action === 'sc-submit' && failSubmit) return { ok: false, error: 'Synthetic pause' };
    return { ok: true };
  } }, storage: { local: { get: (_, cb) => cb({}) }, onChanged: { addListener() {} } } };
  for (const name of ['rejection-reasons.js', 'social-common.js', 'content.js', 'review.js']) {
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
    assert.match(s.w.document.querySelector('article').textContent, /Непроверяемое свойство/);
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
test('each account occupies its own row; supplier claims remain in a separate block', async () => {
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
    assert.deepEqual(supplierRows.map(tr => [...tr.children].map(cell => cell.textContent)),
      [['Подписчики', '100'], ['Непроверяемое свойство', 'Synthetic']]);
    assert.equal(s.w.document.querySelectorAll('article > .scroll').length, 1);
  } finally { s.dom.window.close(); }
});
