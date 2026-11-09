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
test('review renders readable properties, 0 vs null, one product column and unavailable without claiming absence', async () => {
  const s = await review([job('unavailable')]);
  try {
    const table = s.w.document.querySelector('article table');
    assert.equal(table.querySelectorAll('thead th').length, 3);
    const followers = [...table.querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === 'Подписчики');
    assert.deepEqual([...followers.children].map(td => td.textContent), ['Подписчики', '100', '0']);
    const bio = [...table.querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === 'Описание');
    assert.equal(bio.lastChild.textContent, 'Нет данных');
    assert.match(s.w.document.querySelector('.check').textContent, /Недоступно \(не означает отсутствие\)/);
    assert.match(s.w.document.querySelector('article').textContent, /Непроверяемое свойство/);
    assert.equal(s.w.document.querySelector('pre'), null);
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-submit').length, 0);
  } finally { s.dom.window.close(); }
});
test('review queue pauses on first API error rather than advancing or issuing a fresh paid check', async () => {
  const pendingJob = { query: job('pending').query, key: 'synthetic-key' };
  const s = await review([pendingJob, { ...pendingJob, key: 'synthetic-key-2' }], true);
  try {
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-submit').length, 1);
    assert.match(s.w.document.getElementById('notice').textContent, /Очередь приостановлена/);
    assert.equal(s.w.document.getElementById('check').disabled, false);
  } finally { s.dom.window.close(); }
});
