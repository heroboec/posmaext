const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const source = ['rejection-reasons.js', 'content.js']
  .map(file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8')).join('\n');

function row(id, title, { hidden = false, link = true, category = 'Synthetic category' } = {}) {
  return `<tr class="bids-tr-table-new ${hidden ? 'pm-hidden-by-filter' : ''}"><td>
    <a data-bid-id-show-section="${id}"></a>
    ${title === null ? '' : `<div class="bids-item-title"><a>${title}</a></div>`}
    <div data-section-category><span>${category}</span></div>
    ${link ? `<a class="bid-macro-values-edit-outside-link" href="/bids/macro-values/${id}">Edit</a>` : ''}
    <select name="status"><option value="2">Review</option></select>
    </td></tr>`;
}

function setup(html) {
  const dom = new JSDOM(`<table><tbody>${html}</tbody></table>`, {
    url: 'https://example.test/bids', runScripts: 'outside-only',
  });
  const sent = [], pauses = [];
  dom.window.chrome = {
    runtime: { sendMessage: msg => sent.push({ ...msg }) },
    storage: { local: { get: (_, cb) => cb({ urlPatterns: ['/bids'] }) }, onChanged: { addListener() {} } },
  };
  const nativeTimeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (fn, delay, ...args) => {
    if (delay === 800) { pauses.push(() => fn(...args)); return 0; }
    return nativeTimeout(fn, delay, ...args);
  };
  dom.window.eval(source);
  const button = () => {
    const btn = dom.window.document.querySelector('.pm-filter-cookies-btn');
    assert.ok(btn, 'Cookies batch button exists');
    return btn;
  };
  const next = async () => { assert.ok(pauses.length, 'next opening waits 800 ms'); pauses.shift()(); await Promise.resolve(); };
  return { dom, sent, pauses, button, next, doc: dom.window.document };
}

// Catches using row text instead of title, case-sensitive matching, hidden rows and wrong URL type.
test('cookies: title-only case-insensitive match, visible rows with edit links', async () => {
  const s = setup(row(101, 'Synthetic COOKIES product') + row(102, 'Synthetic cookies') +
    row(103, 'Synthetic Cookies', { hidden: true }) + row(104, 'Synthetic Cookies', { link: false }) +
    row(105, 'Synthetic plain product', { category: 'Cookies category' }) + row(106, null));
  try {
    assert.match(s.button().textContent, /\(2\)/);
    s.button().click();
    assert.deepEqual(s.sent, [{ action: 'open-tab', url: 'https://example.test/bids/macro-values/101' }]);
    assert.equal(s.pauses.length, 1);
    await s.next();
    assert.deepEqual(s.sent.map(m => m.url), [
      'https://example.test/bids/macro-values/101', 'https://example.test/bids/macro-values/102',
    ]);
    assert.equal(s.pauses.length, 0);
    assert.equal(s.button().disabled, false);
  } finally { s.dom.window.close(); }
});

// Catches accidental reuse of the old ten-row collector or racing batch actions.
test('cookies: opens more than ten in DOM order, blocks duplicate and other batch actions', async () => {
  const s = setup(Array.from({ length: 12 }, (_, i) => row(i + 101, 'Synthetic cookies')).join(''));
  try {
    s.button().click();
    assert.match(s.button().textContent, /1\/12/);
    for (const selector of ['.pm-filter-cookies-btn', '.pm-filter-open-btn', '.pm-filter-sale-btn']) {
      assert.equal(s.doc.querySelector(selector).disabled, true);
      s.doc.querySelector(selector).click();
    }
    // Calling the handler directly bypasses disabled, but must still respect busy.
    s.button().onclick();
    assert.equal(s.sent.length, 1);
    for (let i = 1; i < 12; i++) await s.next();
    assert.deepEqual(s.sent.map(m => m.url), [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]
      .map(id => `https://example.test/bids/macro-values/${id}`));
    assert.equal(s.button().disabled, false);
    assert.equal(s.doc.querySelector('.pm-filter-open-btn').disabled, false);
  } finally { s.dom.window.close(); }
});

test('cookies: blocked by another batch or modal; old opening still limited to ten', async () => {
  const s = setup(Array.from({ length: 12 }, (_, i) => row(i + 101, 'Synthetic cookies')).join(''));
  try {
    const modal = s.doc.createElement('div'); modal.className = 'pm-modal-backdrop'; s.doc.body.append(modal);
    s.button().click();
    assert.equal(s.sent.length, 0);
    modal.remove();
    s.doc.querySelector('.pm-filter-open-btn').click();
    assert.equal(s.button().disabled, true);
    s.button().onclick();
    for (let i = 1; i < 10; i++) await s.next();
    assert.equal(s.sent.length, 10);
    assert.equal(s.pauses.length, 0);
  } finally { s.dom.window.close(); }
});

// Catches stale counts after mutations or filters, including rows of a known category.
test('cookies: counter follows new rows and category filtering', async () => {
  const s = setup(row(101, 'Synthetic cookies') + row(102, 'Synthetic plain', { category: 'Other' }));
  try {
    s.doc.querySelector('tbody').insertAdjacentHTML('beforeend', row(103, 'Synthetic Cookies'));
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.match(s.button().textContent, /\(2\)/);
    [...s.doc.querySelectorAll('.pm-filter-btn')].find(b => b.textContent === 'Other').click();
    assert.match(s.button().textContent, /\(0\)/);
    s.button().click();
    assert.equal(s.sent.length, 0);
    [...s.doc.querySelectorAll('.pm-filter-btn')].find(b => b.textContent === 'Все').click();
    assert.match(s.button().textContent, /\(2\)/);
  } finally { s.dom.window.close(); }
});
