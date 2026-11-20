const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
async function setup() {
  const dom = new JSDOM(fs.readFileSync('extension/options.html', 'utf8'), { url: 'https://extension.example.test/options.html', runScripts: 'outside-only' });
  const calls = [], permissions = [];
  dom.window.chrome = {
    permissions: { request: async request => { permissions.push(request); return true; } },
    runtime: { sendMessage: async msg => {
      calls.push(msg);
      if (msg.action === 'ai-config-get') return { ok: true, provider: 'openai', url: 'https://api.openai.com/v1/',
        model: 'gpt-4.1-mini', concurrency: 3, hasKey: true };
      if (msg.action === 'ai-models') return { ok: true, models: ['synthetic-model'] };
      return { ok: true };
    } },
  };
  dom.window.eval(fs.readFileSync('extension/ai-options.js', 'utf8'));
  await settle();
  const el = id => dom.window.document.getElementById('ai-' + id);
  return { dom, calls, el, permissions };
}
test('AI settings: key is never returned or displayed, presets populate address and per-provider models', async () => {
  const s = await setup();
  try {
    assert.equal(s.el('key').value, '');
    assert.match(s.el('key-state').textContent, /Ключ сохранён/);
    s.el('provider').value = 'deepseek'; s.el('provider').onchange();
    assert.equal(s.el('url').value, 'https://api.deepseek.com/');
    assert.equal(s.el('model').value, 'deepseek-flash');
    assert.ok([...s.el('models').children].some(o => o.value === 'deepseek-v4-pro'));
  } finally { s.dom.window.close(); }
});
test('AI settings: request only selected origin, save key explicitly and clear input', async () => {
  const s = await setup();
  try {
    s.el('provider').value = 'custom'; s.el('provider').onchange();
    s.el('url').value = 'https://ai.example.test/custom/v1/';
    s.el('model').value = 'synthetic-model'; s.el('key').value = 'SYNTHETIC_AI_KEY';
    await s.el('save').onclick();
    assert.equal(s.permissions[0].origins[0], 'https://ai.example.test/*');
    const saved = s.calls.find(c => c.action === 'ai-config-save').config;
    assert.equal(saved.key, 'SYNTHETIC_AI_KEY'); assert.equal(saved.model, 'synthetic-model');
    assert.equal(s.el('key').value, '');
    await s.el('test').onclick();
    assert.equal(s.el('models').firstChild.value, 'synthetic-model');
  } finally { s.dom.window.close(); }
});
