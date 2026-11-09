const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const file = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function review(jobs, failSubmit = false) {
  const pack = { id: 'synthetic', tabId: 7, entries: [{ bidId: '42', status: '2', category: 'Instagram', subcategory: 'Synthetic',
    column: 0, type: 'username', pageRows: 20, properties: [{ label: 'Подписчики', value: '100' }, { label: 'Непроверяемое свойство', value: 'Synthetic' }], jobs }] };
  const dom = new JSDOM(file('review.html'), { url: 'https://extension.example.test/review.html?id=synthetic', runScripts: 'dangerously' });
  const w = dom.window, messages = [];
  w.setInterval = () => 1;
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
  await settle(); return { w, dom, messages };
}
const job = status => ({ query: { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile' }, key: 'synthetic-key',
  check: { id: 'synthetic-check', status, query: {}, result: { data: { followers: 0, bio: null } } } });
test('account table omits avatar, link, name, username and bio, keeping identity in the heading', async () => {
  const profile = job('found');
  Object.assign(profile.check.result.data, { avatar_url: 'https://example.test/avatar', profile_url: 'https://example.test/profile',
    display_name: 'Synthetic name', username: 'synthetic_name', external_id: '123', registration_date: '2020-05-17' });
  const s = await review([profile]);
  try {
    const card = s.w.document.querySelector('.check');
    const rows = [...card.querySelectorAll('tbody tr')];
    assert.deepEqual(rows.map(tr => tr.firstChild.textContent),
      ['ID', 'Регистрация', 'Публикации', 'Друзья', 'Подписчики', 'Подписки']);
    assert.match(card.querySelector('h3').textContent, /test_profile/);
    assert.equal(rows.find(tr => tr.firstChild.textContent === 'Регистрация').lastChild.textContent, '2020-05-17');
  } finally { s.dom.window.close(); }
});
test('review renders readable properties, 0 vs null, one product column and unavailable without claiming absence', async () => {
  const s = await review([job('unavailable')]);
  try {
    const table = s.w.document.querySelector('article table');
    assert.equal(table.querySelectorAll('thead th').length, 2);
    const followers = [...table.querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === 'Подписчики');
    assert.deepEqual([...followers.children].map(td => td.textContent), ['Подписчики', '0']);
    const registration = [...table.querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === 'Регистрация');
    assert.equal(registration.lastChild.textContent, 'Нет данных');
    assert.match(s.w.document.querySelector('.check').textContent, /Недоступно \(не означает отсутствие\)/);
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
test('each account shows only its own data; supplier claims remain in a separate block', async () => {
  const first = job('found'), second = job('found');
  first.query.identifier = 'synthetic_first'; first.check.result.data.followers = 120;
  second.query.identifier = 'synthetic_second'; second.check.result.data.followers = 5;
  const s = await review([first, second]);
  try {
    const cards = [...s.w.document.querySelectorAll('.check')];
    assert.equal(cards.length, 2);
    for (const [i, actual] of ['120', '5'].entries()) {
      const table = cards[i].querySelector('table');
      assert.ok(table, 'Each account needs its own data table');
      assert.deepEqual([...table.querySelectorAll('thead th')].map(th => th.textContent),
        ['Свойство', 'Данные аккаунта']);
      const followers = [...table.querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === 'Подписчики');
      assert.deepEqual([...followers.children].map(td => td.textContent), ['Подписчики', actual]);
      assert.equal(table.querySelectorAll('thead th').length, 2);
    }
    const supplierRows = [...s.w.document.querySelectorAll('article > table tr')];
    assert.deepEqual(supplierRows.map(tr => [...tr.children].map(cell => cell.textContent)),
      [['Подписчики', '100'], ['Непроверяемое свойство', 'Synthetic']]);
    assert.equal(s.w.document.querySelectorAll('article > .scroll').length, 0);
  } finally { s.dom.window.close(); }
});
