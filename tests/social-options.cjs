const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function options() {
  const dom = new JSDOM(`<input id="social-url"><input id="social-interval">
    <textarea id="social-mapping"></textarea><input id="social-key"><input id="social-clear-key" type="checkbox">
    <div id="social-key-state"></div><button id="social-save"></button><button id="social-test"></button>
    <p id="social-status"></p>`, { runScripts: 'outside-only' });
  const w = dom.window, requests = [], timers = new Map(); let nextTimer = 0, resolveTest, resolvePoll;
  w.setInterval = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  w.clearInterval = id => timers.delete(id);
  w.chrome = { runtime: { sendMessage: async msg => {
    requests.push(msg.action);
    if (msg.action === 'sc-config-get') return { ok: true, url: 'https://api.example.test/', interval: 800, mapping: {}, hasKey: true };
    if (msg.action === 'sc-test') return new Promise(resolve => { resolveTest = resolve; });
    if (msg.action === 'sc-test-status') return new Promise(resolve => { resolvePoll = resolve; });
    throw new Error('Unexpected message');
  } } };
  w.eval(fs.readFileSync(require.resolve('../extension/social-options.js'), 'utf8'));
  return { dom, requests, timers, node: id => w.document.getElementById('social-' + id),
    start: () => w.document.getElementById('social-test').onclick(),
    poll: async value => { const p = [...timers.values()][0](); resolvePoll(value); await p; },
    finish: value => resolveTest(value),
    pendingPoll: () => [...timers.values()][0](),
    resolvePoll: value => resolvePoll(value) };
}

test('connection UI shows cooldown countdown and HTTP stage without extra API checks, then stops polling', async () => {
  const o = options();
  try {
    const pending = o.start();
    assert.equal(o.node('test').disabled, true);
    await o.poll({ ok: true, test: { stage: 'cooldown', waitUntil: Date.now() + 60000 } });
    assert.match(o.node('status').textContent, /Сохранённая пауза.*ещё \d+ с/);
    await o.poll({ ok: true, test: { stage: 'response' } });
    assert.match(o.node('status').textContent, /Запрос отправлен/);
    o.finish({ ok: false, error: 'Synthetic timeout', stage: 'response' });
    await pending;
    assert.match(o.node('status').textContent, /Synthetic timeout.*Этап:.*ответа API/);
    assert.equal(o.node('test').disabled, false);
    assert.equal(o.timers.size, 0);
    assert.equal(o.requests.filter(a => a === 'sc-test').length, 1);
  } finally { o.dom.window.close(); }
});
test('a late status response cannot overwrite the completed connection result', async () => {
  const o = options();
  try {
    const pending = o.start(), poll = o.pendingPoll();
    o.finish({ ok: true, catalog: [] });
    await pending;
    const final = o.node('status').textContent;
    o.resolvePoll({ ok: true, test: { stage: 'queue' } });
    await poll;
    assert.equal(o.node('status').textContent, final);
    assert.match(final, /Связь есть/);
  } finally { o.dom.window.close(); }
});
test('a silent worker is reported even if its status message never resolves', async () => {
  const o = options();
  try {
    let now = 100000;
    o.dom.window.Date.now = () => now;
    const pending = o.start(), poll = o.pendingPoll();
    now += 6000;
    await o.pendingPoll();
    assert.match(o.node('status').textContent, /не сообщает этап.*5 с/);
    o.finish({ ok: false, error: 'Synthetic worker failure' });
    await pending;
    o.resolvePoll({ ok: true, test: { stage: 'queue' } });
    await poll;
    assert.equal(o.node('status').textContent, 'Synthetic worker failure');
    assert.equal(o.timers.size, 0);
  } finally { o.dom.window.close(); }
});
