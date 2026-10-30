const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
const row = id => `<tr class="tr_default bids-tr-table-new"><td>
<select id="status_id${id}" data-current-status="2" onchange="window.nativeChanges++">
<option value="2" selected>Review</option><option value="3">Sale</option><option value="4">Declined</option></select>
<div class="bids-section-reason" style="display:none"><span class="bids-edit-reason-${id}"></span></div>
</td></tr>`;
function setup(macro = false, patterns = ['/bids']) {
  const dom = new JSDOM(`<meta name="csrf-token" content="test-token">${macro ?
    '<form id="bid-macro-values-edit-form" action="/bids/macro-values-save/42"><button type="submit">Save</button></form>' :
    `<table><tbody>${row(42)}</tbody></table>`}`, {
    url: `https://example.test/bids/${macro ? 'macro-values/42' : 'list'}`, runScripts: 'dangerously',
  });
  const w = dom.window;
  w.nativeChanges = 0;
  w.chrome = { storage: { local: { get: (_, cb) => cb({ urlPatterns: patterns }) }, onChanged: { addListener() {} } } };
  const requests = [];
  w.fetch = async (url, opts) => {
    requests.push({ url, body: new URLSearchParams(opts.body.toString()) });
    return { ok: true, text: async () => '{"status":"ok"}' };
  };
  w.eval(source);
  const q = s => w.document.querySelector(s) || w.document.querySelector('.pm-modal-backdrop')?.shadowRoot.querySelector(s) || null;
  const change = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const open = () => macro ? q('.pm-float-decline').click() : change(q('#status_id42'), '4');
  return { dom, w, q, change, open, requests };
}
const settle = () => new Promise(r => setImmediate(r));
for (const macro of [false, true]) {
  test(`${macro ? 'edit' : 'list'}: template can be edited and final reason is sent once`, async () => {
    const s = setup(macro);
    try {
      s.open();
      assert.equal(s.requests.length, 0);
      assert.equal(s.q('.pm-reason-template').options.length, 13);
      assert.equal(s.q('.pm-reason-template').options[12].title, "TEST_MESSAGE_12");
      s.change(s.q('.pm-reason-template'), '7');
      assert.equal(s.q('.pm-modal-reason').value, 'TEST_MESSAGE_08');
      s.q('.pm-modal-reason').value += ' Edited by operator.';
      const expected = s.q('.pm-modal-reason').value;
      s.q('.pm-modal-submit').click();
      s.q('.pm-modal-reason').dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await settle();
      assert.equal(s.requests.length, 1);
      assert.equal(s.requests[0].body.get('message'), expected);
      assert.equal(s.requests[0].body.get('status'), '4');
      assert.equal(s.requests[0].body.get('bid_id'), '42');
      assert.equal(s.requests[0].url, 'https://example.test/req/bids.php');
      assert.equal(s.q('.pm-modal-backdrop'), null);
      if (!macro) {
        assert.equal(s.w.nativeChanges, 0);
        assert.equal(s.q('#status_id42').value, '4');
        assert.equal(s.q('.bids-edit-reason-42').textContent, expected);
      }
    } finally { s.dom.window.close(); }
  });
  test(`${macro ? 'edit' : 'list'}: manual reason, empty validation, retry and cancellation`, async () => {
    const s = setup(macro);
    try {
      s.open(); s.q('.pm-modal-submit').click();
      assert.equal(s.requests.length, 0);
      assert.equal(s.q('.pm-modal-error').textContent, 'Укажите причину');
      s.q('.pm-modal-cancel').click();
      assert.equal(s.requests.length, 0);
      if (!macro) assert.equal(s.q('#status_id42').value, '2');
      s.open();
      s.q('.pm-modal-reason').value = 'My own reason';
      const fetch = s.w.fetch;
      s.w.fetch = async () => ({ ok: true, text: async () => '{"status":"error","message":"Retry"}' });
      s.q('.pm-modal-submit').click(); await settle();
      assert.equal(s.q('.pm-modal-reason').value, 'My own reason');
      assert.equal(s.q('.pm-reason-template').disabled, false);
      if (!macro) assert.equal(s.q('#status_id42').value, '2');
      s.w.fetch = fetch;
      s.q('.pm-modal-submit').click(); await settle();
      assert.equal(s.requests[0].body.get('message'), 'My own reason');
    } finally { s.dom.window.close(); }
  });
}
test('list: other statuses, newly added rows and URL scope', () => {
  const s = setup();
  try {
    s.change(s.q('#status_id42'), '3');
    assert.equal(s.w.nativeChanges, 1);
    s.change(s.q('#status_id42'), '4');
    s.q('.pm-modal-cancel').click();
    assert.equal(s.q('#status_id42').value, '3');
    s.q('tbody').insertAdjacentHTML('beforeend', row(43));
    s.change(s.q('#status_id43'), '4');
    assert.match(s.q('.pm-modal-title').textContent, /43/);
  } finally { s.dom.window.close(); }
  const independent = setup(false, []);
  try {
    independent.open();
    assert.ok(independent.q('.pm-modal-backdrop'));
    assert.equal(independent.w.nativeChanges, 0);
  } finally { independent.dom.window.close(); }
  const other = setup(false, []);
  other.dom.reconfigure({ url: 'https://example.test/unrelated' });
  try {
    other.open();
    assert.equal(other.q('.pm-modal-backdrop'), null);
    assert.equal(other.w.nativeChanges, 1);
  } finally { other.dom.window.close(); }
});

test('page bridge: direct site calls open our dialog without sending the native request', async () => {
  const s = setup(false, []);
  try {
    const nativeCalls = [];
    s.w.admin_bids = { change_status(...args) { nativeCalls.push({ self: this, args }); return 'native'; } };
    s.w.eval(fs.readFileSync(path.join(__dirname, '../extension/page-bridge.js'), 'utf8'));
    assert.equal(s.w.admin_bids.change_status(42, 3, 'extra'), 'native');
    assert.equal(nativeCalls[0].self, s.w.admin_bids);
    assert.deepEqual(nativeCalls[0].args, [42, 3, 'extra']);
    s.q('#status_id42').value = '4';
    s.w.admin_bids.change_status(42, 4);
    assert.equal(nativeCalls.length, 1);
    assert.ok(s.q('.pm-modal-backdrop'));
    assert.equal(s.requests.length, 0);
    s.change(s.q('.pm-reason-template'), '11');
    s.q('.pm-modal-submit').click(); await settle();
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].body.get('message'), 'TEST_MESSAGE_12');
    s.dom.reconfigure({ url: 'https://example.test/unrelated' });
    assert.equal(s.w.admin_bids.change_status(42, 4), 'native');
    assert.equal(nativeCalls.length, 2);
  } finally { s.dom.window.close(); }
});

test('dialog: Escape from selector cancels; Tab stays inside the dialog', () => {
  const s = setup(true);
  try {
    s.open();
    const root = s.q('.pm-modal-backdrop').shadowRoot;
    s.q('.pm-modal-submit').focus();
    s.q('.pm-modal-submit').dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(root.activeElement, s.q('.pm-reason-template'));
    s.q('.pm-reason-template').dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(s.q('.pm-modal-backdrop'), null);
    assert.equal(s.requests.length, 0);
  } finally { s.dom.window.close(); }
});

test('page bridge: late site initialization and fallback without the content script', async () => {
  const dom = new JSDOM('<select id="status_id42"><option value="4">Declined</option></select>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../extension/page-bridge.js'), 'utf8'));
    let calls = 0;
    dom.window.admin_bids = { change_status() { calls++; return 'original'; } };
    await new Promise(r => setTimeout(r, 550));
    assert.equal(dom.window.admin_bids.change_status(42, 4), 'original');
    assert.equal(calls, 1);
  } finally { dom.window.close(); }
});
