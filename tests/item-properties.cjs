const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const source = ['rejection-reasons.js', 'content.js']
  .map(file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8')).join('\n');

const row = (bid, onclick, cls = 'tr_default') => `<tr class="bids-tr-table-new ${cls}"><td>
  <div id="item_control_${bid}"><a href="#" onclick="${onclick}">Synthetic item</a></div>
  </td></tr>`;
function setup(html, url = 'https://example.test/bids') {
  const dom = new JSDOM(`<table><tbody>${html}</tbody></table>`, { url, runScripts: 'outside-only' });
  dom.window.chrome = { storage: { local: { get: (_, cb) => cb({}) }, onChanged: { addListener() {} } } };
  dom.window.eval(source);
  return dom;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 380));

test('item properties: uses second argument and current origin for every row class', () => {
  const dom = setup(row(101, 'admin_bids.item_id_dialog(101, 901)') +
    row(102, 'return admin_bids.item_id_dialog( 102 , 902 );', 'tr_saled'));
  try {
    const links = [...dom.window.document.querySelectorAll('.pm-item-properties-link')];
    assert.deepEqual(links.map(link => link.href), [
      'https://example.test/catalog/item-properties/901',
      'https://example.test/catalog/item-properties/902',
    ]);
    assert.ok(links.every(link => link.target === '_blank' && link.rel.includes('noopener')));
    assert.equal(dom.window.document.querySelector('#item_control_101 a').getAttribute('onclick'),
      'admin_bids.item_id_dialog(101, 901)');
  } finally { dom.window.close(); }
});

test('item properties: no link for absent, zero or malformed item ID', () => {
  const dom = setup(row(101, 'admin_bids.item_id_dialog(101)') +
    row(102, 'admin_bids.item_id_dialog(102, 0)') + row(103, 'other.item_id_dialog(103, 903)'));
  try {
    assert.equal(dom.window.document.querySelectorAll('.pm-item-properties-link').length, 0);
  } finally { dom.window.close(); }
});

test('item properties: new rows, changed association and removal stay in sync without duplicates', async () => {
  const dom = setup(row(101, 'admin_bids.item_id_dialog(101, 901)'));
  try {
    const doc = dom.window.document;
    doc.querySelector('tbody').insertAdjacentHTML('beforeend', row(102, 'admin_bids.item_id_dialog(102, 902)'));
    await settle();
    assert.equal(doc.querySelectorAll('.pm-item-properties-link').length, 2);
    doc.querySelector('#item_control_101 a').setAttribute('onclick', 'admin_bids.item_id_dialog(101, 905)');
    await settle();
    assert.equal(doc.querySelector('#item_control_101 .pm-item-properties-link').href,
      'https://example.test/catalog/item-properties/905');
    doc.querySelector('#item_control_101 a').removeAttribute('onclick');
    await settle();
    assert.equal(doc.querySelector('#item_control_101 .pm-item-properties-link'), null);
    assert.equal(doc.querySelectorAll('.pm-item-properties-link').length, 1);
  } finally { dom.window.close(); }
});

test('item properties: unrelated pages are not modified', () => {
  const dom = setup(row(101, 'admin_bids.item_id_dialog(101, 901)'), 'https://example.test/catalog');
  try {
    assert.equal(dom.window.document.querySelector('.pm-item-properties-link'), null);
  } finally { dom.window.close(); }
});
