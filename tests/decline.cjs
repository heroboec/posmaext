const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/rejection-reasons.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
// Synthetic fixture: never put real user rejection reasons in tests.
const importedReasons = Array.from({ length: 12 }, (_, i) => `TEST_MESSAGE_${String(i + 1).padStart(2, '0')}`);
const row = (id, rowClass = 'tr_default') => `<tr class="${rowClass} bids-tr-table-new"><td>
<select id="status_id${id}" data-current-status="2" onchange="window.nativeChanges++">
<option value="2" selected>Review</option><option value="3">Sale</option><option value="4">Declined</option></select>
<div class="bids-section-reason" style="display:none"><span class="bids-edit-reason-${id}"></span></div>
</td></tr>`;
function setup(macro = false, patterns = ['/bids'], count = 1, rowClasses = [], declineReasons = importedReasons) {
  const dom = new JSDOM(`<meta name="csrf-token" content="test-token">${macro ?
    '<form id="bid-macro-values-edit-form" action="/bids/macro-values-save/42"><button type="submit">Save</button></form>' :
    `<table><tbody>${Array.from({length: count}, (_, i) => row(42 + i, rowClasses[i])).join('')}</tbody></table>`}`, {
    url: `https://example.test/bids/${macro ? 'macro-values/42' : 'list'}`, runScripts: 'dangerously',
  });
  const w = dom.window;
  w.nativeChanges = 0;
  w.chrome = { storage: { local: { get: (_, cb) => cb({ urlPatterns: patterns, declineReasons }) }, onChanged: { addListener() {} } } };
  const storageListeners = [];
  w.chrome.storage.onChanged.addListener = cb => storageListeners.push(cb);
  const requests = [];
  w.fetch = async (url, opts) => {
    requests.push({ url, body: new URLSearchParams(opts.body.toString()) });
    return { ok: true, text: async () => '{"status":"ok"}' };
  };
  w.eval(source);
  const q = s => w.document.querySelector(s) || w.document.querySelector('.pm-modal-backdrop')?.shadowRoot.querySelector(s) || w.document.querySelector('.pm-selection-toolbar')?.shadowRoot.querySelector(s) || null;
  const change = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const open = () => macro ? q('.pm-float-decline').click() : change(q('#status_id42'), '4');
  return { dom, w, q, change, open, requests, storageListeners };
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

test('selected batch: more than 10, DOM order, same edited reason, sequential requests', async () => {
  const s = setup(false, [], 12);
  try {
    const delays = [];
    const timeout = s.w.setTimeout.bind(s.w);
    s.w.setTimeout = (fn, ms, ...args) => {
      if (ms === 800) { delays.push(ms); return timeout(fn, 1, ...args); }
      return timeout(fn, ms, ...args);
    };
    let active = 0, maxActive = 0;
    const fetch = s.w.fetch;
    s.w.fetch = async (...args) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 2));
      const result = await fetch(...args); active--; return result;
    };
    assert.equal(s.w.document.querySelectorAll('.pm-bid-select').length, 12);
    s.q('.pm-selection-all').click();
    assert.equal(s.q('.pm-selection-count').textContent, 'Выбрано: 12');
    s.q('.pm-selection-decline').click();
    assert.match(s.q('.pm-modal-title').textContent, /12/);
    assert.match(s.q('.pm-modal-summary').textContent, /#53/);
    s.change(s.q('.pm-reason-template'), '1');
    s.q('.pm-modal-reason').value += ' Corrected.';
    const expected = s.q('.pm-modal-reason').value;
    s.q('.pm-modal-submit').click();
    assert.equal(s.q('.pm-bid-select').disabled, true);
    for (let i = 0; i < 100 && s.q('.pm-modal-backdrop'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(s.q('.pm-modal-backdrop'), null);
    assert.equal(s.requests.length, 12);
    assert.deepEqual(s.requests.map(r => r.body.get('bid_id')), Array.from({length:12}, (_, i) => String(42+i)));
    assert.ok(s.requests.every(r => r.body.get('message') === expected));
    assert.equal(maxActive, 1);
    assert.equal(delays.length, 11);
    assert.equal(s.q('.pm-selection-count').textContent, 'Выбрано: 0');
    assert.match(s.q('.pm-selection-result').textContent, /Отклонено: 12 из 12/);
  } finally { s.dom.window.close(); }
});

test('selected batch: partial failure retains failed selection; retry excludes successes', async () => {
  const s = setup(false, ['/bids'], 3);
  try {
    const timeout = s.w.setTimeout.bind(s.w);
    s.w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 800 ? 1 : ms, ...args);
    const fetch = s.w.fetch;
    let fail = true;
    s.w.fetch = async (...args) => {
      const result = await fetch(...args);
      const id = s.requests.at(-1).body.get('bid_id');
      return fail && id === '43' ? { ok: false, status: 500, text: async () => 'error' } : result;
    };
    s.q('.pm-selection-all').click(); s.q('.pm-selection-decline').click();
    s.q('.pm-modal-reason').value = 'Manual batch reason';
    s.q('.pm-modal-submit').click();
    for (let i = 0; i < 100 && s.q('.pm-modal-submit').disabled; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(s.q('#status_id42').value, '4');
    assert.equal(s.q('#status_id43').value, '2');
    assert.equal(s.q('#status_id44').value, '4');
    assert.match(s.q('.pm-modal-error').textContent, /#43/);
    assert.equal(s.q('.pm-modal-reason').value, 'Manual batch reason');
    assert.equal(s.q('.pm-selection-count').textContent, 'Выбрано: 1');
    fail = false; s.q('.pm-modal-submit').click(); await settle();
    assert.deepEqual(s.requests.map(r => r.body.get('bid_id')), ['42','43','44','43']);
    assert.equal(s.q('.pm-modal-backdrop'), null);
    assert.match(s.q('.pm-selection-result').textContent, /Отклонено: 3 из 3/);
  } finally { s.dom.window.close(); }
});

test('selected batch: cancellation sends nothing; hidden and removed rows are deselected', async () => {
  const s = setup(false, [], 3);
  try {
    s.q('.pm-selection-all').click(); s.q('.pm-selection-decline').click();
    s.q('.pm-modal-cancel').click(); assert.equal(s.requests.length, 0);
    s.q('#status_id43').closest('tr').classList.add('pm-hidden-by-filter');
    s.q('#status_id44').closest('tr').remove();
    await new Promise(r => setTimeout(r, 180));
    assert.equal(s.q('.pm-selection-count').textContent, 'Выбрано: 1');
    s.q('.pm-selection-decline').click();
    assert.equal(s.q('.pm-modal-summary').textContent, '#42');
    s.q('.pm-modal-cancel').click();
    s.q('tbody').insertAdjacentHTML('beforeend', row(45)); await new Promise(r => setTimeout(r, 180));
    assert.equal(s.w.document.querySelectorAll('.pm-bid-select').length, 3);
    assert.equal(s.q('#status_id45').closest('tr').querySelector('.pm-bid-select').checked, false);
  } finally { s.dom.window.close(); }
});

test('all bid row styles: checkboxes, filters, detail expansion, batch links and rejection', async () => {
  const s = setup(false, ['/bids'], 3, ['tr_default', 'tr_saled', '']);
  try {
    assert.equal(s.w.document.querySelectorAll('.pm-bid-select').length, 3);
    for (const id of [42, 43, 44]) {
      const tr = s.q(`#status_id${id}`).closest('tr');
      tr.cells[0].insertAdjacentHTML('beforeend', `<div data-section-category="${id}"><span>${id === 42 ? 'Other' : 'Facebook'}</span></div>
        <a data-bid-id-show-section="${id}"></a><a class="bid-macro-values-edit-outside-link" href="/bids/macro-values/${id}"></a>`);
      tr.insertAdjacentHTML('afterend', '<tr class="tr-hidden-bid" style="display:none"><td>Details</td></tr>');
    }
    await new Promise(r => setTimeout(r, 180));
    assert.equal(s.q('.pm-filter-open-btn').textContent, '↗ Править значения (3)');
    assert.equal(s.q('.pm-filter-sale-btn').textContent, '🛒 В продаже (3)');
    const facebook = [...s.w.document.querySelectorAll('.pm-filter-btn')].find(b => b.textContent === 'Facebook');
    assert.ok(facebook); facebook.click();
    assert.equal(s.q('.pm-filter-open-btn').textContent, '↗ Править значения (2)');
    assert.equal(s.q('.pm-filter-sale-btn').textContent, '🛒 В продаже (2)');
    assert.equal(s.q('#status_id42').closest('tr').classList.contains('pm-hidden-by-filter'), true);
    assert.equal(s.q('#status_id43').closest('tr').classList.contains('pm-hidden-by-filter'), false);
    s.q('.pm-filter-expand-btn').click();
    assert.equal(s.q('#status_id43').closest('tr').nextElementSibling.style.display, 'table-row');
    s.q('#status_id43').closest('tr').querySelector('.pm-bid-select').click();
    s.q('.pm-selection-decline').click();
    assert.equal(s.q('.pm-modal-summary').textContent, '#43');
    s.q('.pm-modal-reason').value = 'Test reason for a tr_saled row';
    s.q('.pm-modal-submit').click(); await settle();
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].body.get('bid_id'), '43');
    assert.equal(s.q('#status_id43').value, '4');
    assert.equal(s.q('#status_id43').closest('tr').querySelector('.pm-bid-select').disabled, true);
    assert.equal(s.q('#status_id44').value, '2');
  } finally { s.dom.window.close(); }
});

for (const macro of [false, true]) {
  test(`${macro ? 'edit' : 'list'}: saved custom reasons are editable and sent`, async () => {
    const s = setup(macro, ['/bids'], 1, [], ['Custom reason one', 'Вторая причина https://example.test/help']);
    try {
      s.open();
      assert.equal(s.q('.pm-reason-template').options.length, 3);
      s.change(s.q('.pm-reason-template'), '1');
      assert.equal(s.q('.pm-modal-reason').value, 'Вторая причина https://example.test/help');
      s.q('.pm-modal-reason').value += ' — уточнение';
      s.q('.pm-modal-submit').click(); await settle();
      assert.equal(s.requests[0].body.get('message'), 'Вторая причина https://example.test/help — уточнение');
    } finally { s.dom.window.close(); }
  });
}

test('settings updates: open dialog keeps its draft and template mapping; next dialog uses new list', () => {
  const s = setup(true);
  try {
    s.open(); s.q('.pm-modal-reason').value = 'Draft';
    s.storageListeners.forEach(cb => cb({ declineReasons: { newValue: ['New reason'] } }, 'local'));
    assert.equal(s.q('.pm-modal-reason').value, 'Draft');
    s.change(s.q('.pm-reason-template'), '0');
    assert.equal(s.q('.pm-modal-reason').value, 'TEST_MESSAGE_01');
    s.q('.pm-modal-cancel').click(); s.open();
    assert.equal(s.q('.pm-reason-template').options.length, 2);
    s.change(s.q('.pm-reason-template'), '0');
    assert.equal(s.q('.pm-modal-reason').value, 'New reason');
    s.q('.pm-modal-cancel').click();
    s.storageListeners.forEach(cb => cb({ declineReasons: { newValue: [] } }, 'local'));
    s.open(); assert.equal(s.q('.pm-reason-template').options.length, 1);
    s.q('.pm-modal-cancel').click();
    s.storageListeners.forEach(cb => cb({ declineReasons: {} }, 'local'));
    s.open(); assert.equal(s.q('.pm-reason-template').options.length, 1);
  } finally { s.dom.window.close(); }
});

test('selected batch uses the updated custom reason', async () => {
  const s = setup(false, [], 2);
  try {
    const timeout = s.w.setTimeout.bind(s.w);
    s.w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 800 ? 1 : ms, ...args);
    s.storageListeners.forEach(cb => cb({ declineReasons: { newValue: ['Shared custom reason'] } }, 'local'));
    s.q('.pm-selection-all').click(); s.q('.pm-selection-decline').click();
    s.change(s.q('.pm-reason-template'), '0');
    s.q('.pm-modal-submit').click();
    for (let i = 0; i < 100 && s.q('.pm-modal-backdrop'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(s.requests.length, 2);
    assert.ok(s.requests.every(r => r.body.get('message') === 'Shared custom reason'));
  } finally { s.dom.window.close(); }
});

test('without a saved list: no built-in templates, manual rejection still sends', async () => {
  const s = setup(true, [], 1, [], null);
  try {
    s.open();
    assert.equal(s.q('.pm-reason-template').options.length, 1);
    s.q('.pm-modal-reason').value = 'Reason typed by operator';
    s.q('.pm-modal-submit').click(); await settle();
    assert.equal(s.requests[0].body.get('message'), 'Reason typed by operator');
  } finally { s.dom.window.close(); }
});
