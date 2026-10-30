const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
function setup(initial = {}) {
  const dom = new JSDOM(read('options.html'), { runScripts: 'outside-only' });
  const w = dom.window, data = { ...initial }, writes = [];
  w.chrome = {
    runtime: { getManifest: () => ({ version: '2.13' }), reload() {} },
    storage: { local: {
      remove() {}, get: (_, cb) => cb(data),
      set: (value, cb) => { writes.push(value); Object.assign(data, value); cb(); },
    } },
  };
  w.eval(read('rejection-reasons.js') + '\n' + read('options.js'));
  return { dom, w, data, writes, q: sel => w.document.querySelector(sel) };
}

test('options: defaults, custom lines, empty list and restoring defaults are saved explicitly', () => {
  const s = setup({ urlPatterns: ['/bids'] });
  try {
    assert.equal(s.q('#reason-count').textContent, 'Причин: 12');
    assert.equal(s.q('#url-patterns').value, '/bids');
    assert.equal(s.writes.length, 0);
    s.q('#decline-reasons').value = ' First reason \n\nВторая причина с ссылкой https://example.test\n';
    s.q('#decline-reasons').dispatchEvent(new s.w.Event('input'));
    assert.equal(s.q('#reason-count').textContent, 'Причин: 2');
    s.q('#save-btn').click();
    assert.deepEqual(Array.from(s.data.declineReasons), ['First reason', 'Вторая причина с ссылкой https://example.test']);
    assert.deepEqual(Array.from(s.data.urlPatterns), ['/bids']);
    s.q('#decline-reasons').value = ''; s.q('#save-btn').click();
    assert.equal(s.data.declineReasons.length, 0);
    s.q('#restore-reasons').click();
    assert.equal(s.data.declineReasons.length, 0);
    s.q('#save-btn').click(); assert.equal(s.data.declineReasons.length, 12);
  } finally { s.dom.window.close(); }
});

test('options: existing custom and explicitly empty lists survive reopening', () => {
  for (const values of [['Saved custom reason'], []]) {
    const s = setup({ declineReasons: values });
    try {
      assert.equal(s.q('#decline-reasons').value, values.join('\n'));
      assert.equal(s.writes.length, 0);
    } finally { s.dom.window.close(); }
  }
});

test('options: UTF-8 TXT import replaces draft only, supports BOM and CRLF, then saves', async () => {
  const s = setup({ declineReasons: ['Old reason'] });
  try {
    const file = new s.w.File(['\uFEFFПервая причина\r\n\r\nSecond reason with https://example.test\rThird\n'], 'reasons.txt', { type: 'text/plain' });
    Object.defineProperty(s.q('#reason-file'), 'files', { configurable: true, value: [file] });
    s.q('#reason-file').dispatchEvent(new s.w.Event('change'));
    assert.equal(s.q('#save-btn').disabled, true);
    for (let i = 0; i < 100 && s.q('#save-btn').disabled; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(s.q('#decline-reasons').value, 'Первая причина\nSecond reason with https://example.test\nThird');
    assert.deepEqual(s.data.declineReasons, ['Old reason']);
    assert.equal(s.writes.length, 0);
    s.q('#save-btn').click(); assert.equal(s.data.declineReasons.length, 3);
  } finally { s.dom.window.close(); }
});

test('options: read and storage failures are shown without losing edited text', async () => {
  const s = setup({ declineReasons: ['Keep me'] });
  try {
    s.w.FileReader = class { readAsText() { this.onerror(); } };
    Object.defineProperty(s.q('#reason-file'), 'files', { value: [{}] });
    s.q('#reason-file').dispatchEvent(new s.w.Event('change'));
    await new Promise(r => setImmediate(r));
    assert.equal(s.q('#decline-reasons').value, 'Keep me');
    assert.match(s.q('#reason-status').textContent, /Не удалось/);
    s.w.chrome.storage.local.set = (_, cb) => {
      s.w.chrome.runtime.lastError = { message: 'quota error' }; cb();
      delete s.w.chrome.runtime.lastError;
    };
    s.q('#save-btn').click();
    assert.match(s.q('#status').textContent, /quota error/);
    assert.equal(s.q('#decline-reasons').value, 'Keep me');
    assert.equal(s.q('#save-btn').disabled, false);
  } finally { s.dom.window.close(); }
});
