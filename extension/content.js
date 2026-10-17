'use strict';

let pmUrlPatterns = [];
const pmActiveFilters = new Set(); // selected category names
const pmKnownCats     = new Map(); // name → { name, icon }
let   pmAllExpanded   = false;
let   pmObserver      = null;

function pmUrlMatches() {
  if (!pmUrlPatterns.length) return false;
  return pmUrlPatterns.some(p => p && location.href.includes(p));
}

// ── Filter panel ──────────────────────────────────────────────────────────────

function pmGetRowCategory(tr) {
  const div = tr.querySelector('div[data-section-category]');
  if (!div) return null;
  const name = div.querySelector('span')?.textContent.trim();
  const icon = div.querySelector('img')?.getAttribute('src');
  return name ? { name, icon } : null;
}

function pmApplyFilter() {
  document.querySelectorAll('tr.tr_default.bids-tr-table-new').forEach(tr => {
    let hide = false;
    if (pmActiveFilters.size) {
      const cat = pmGetRowCategory(tr);
      hide = !(cat && pmActiveFilters.has(cat.name));
    }
    tr.classList.toggle('pm-hidden-by-filter', hide);
    const detail = tr.nextElementSibling;
    if (detail?.classList.contains('tr-hidden-bid')) {
      detail.classList.toggle('pm-hidden-by-filter', hide);
    }
  });
}

function pmToggleAllDetails() {
  pmAllExpanded = !pmAllExpanded;
  document.querySelectorAll('tr.tr_default.bids-tr-table-new:not(.pm-hidden-by-filter)').forEach(tr => {
    const hiddenRow = tr.nextElementSibling;
    if (!hiddenRow?.classList.contains('tr-hidden-bid')) return;
    const isShown = getComputedStyle(hiddenRow).display !== 'none';
    if (pmAllExpanded === isShown) return; // already in desired state
    const anchor = tr.querySelector('a[data-bid-id-show-section]');
    const bidId  = anchor?.getAttribute('data-bid-id-show-section');
    if (bidId && typeof window.bids?.toggleSection === 'function') {
      window.bids.toggleSection(parseInt(bidId, 10));
    } else {
      hiddenRow.style.display = pmAllExpanded ? 'table-row' : 'none';
    }
  });
  const btn = document.querySelector('.pm-filter-expand-btn');
  if (btn) btn.textContent = pmAllExpanded ? '▲ Свернуть' : '▼ Раскрыть';
}

// ── Batch actions: open "Править значения заявки" / set status "в продаже" ───
// Both work on the same batch: the first PM_BATCH_LIMIT visible bids, top to bottom.

const PM_BATCH_LIMIT   = 10;
const PM_BATCH_DELAY   = 800;
const PM_REVIEW_STATUS = new Set(['2', '6', '7']); // на проверке / 48ч / 72ч
const PM_SALE_STATUS   = '3';                       // аккаунты в продаже
let   pmBusy = null; // null = idle, otherwise { kind: 'open' | 'sale', progress: 'i/total' }

function pmGetBatch() {
  const batch = [];
  for (const tr of document.querySelectorAll('tr.tr_default.bids-tr-table-new:not(.pm-hidden-by-filter)')) {
    const bidId = tr.querySelector('a[data-bid-id-show-section]')?.getAttribute('data-bid-id-show-section');
    if (!bidId) continue;
    batch.push({
      bidId,
      link:   tr.querySelector('a.bid-macro-values-edit-outside-link')?.href || null,
      select: tr.querySelector(`#status_id${bidId}`) || tr.querySelector('select[name="status"]'),
    });
    if (batch.length >= PM_BATCH_LIMIT) break;
  }
  return batch;
}

function pmSaleCandidates(batch) {
  return batch.filter(b => b.select && PM_REVIEW_STATUS.has(b.select.value));
}

function pmOpenBtnText() {
  if (pmBusy?.kind === 'open') return `… ${pmBusy.progress}`;
  return `↗ Править значения (${pmGetBatch().filter(b => b.link).length})`;
}

function pmSaleBtnText() {
  if (pmBusy?.kind === 'sale') return `… ${pmBusy.progress}`;
  return `🛒 В продаже (${pmSaleCandidates(pmGetBatch()).length})`;
}

function pmSetBusy(kind, i, total) {
  pmBusy = { kind, progress: `${i}/${total}` };
  const btn = document.querySelector(kind === 'open' ? '.pm-filter-open-btn' : '.pm-filter-sale-btn');
  if (btn) btn.textContent = kind === 'open' ? pmOpenBtnText() : pmSaleBtnText();
}

async function pmRunBatch(kind, items, step) {
  document.querySelectorAll('.pm-filter-open-btn, .pm-filter-sale-btn').forEach(b => { b.disabled = true; });
  for (let i = 0; i < items.length; i++) {
    pmSetBusy(kind, i + 1, items.length);
    step(items[i]);
    if (i < items.length - 1) await new Promise(r => setTimeout(r, PM_BATCH_DELAY));
  }
  pmBusy = null;
  pmRenderFilterPanel();
}

function pmOpenMacroLinks() {
  if (pmBusy) return;
  const items = pmGetBatch().filter(b => b.link);
  if (!items.length) return;
  pmRunBatch('open', items, b => chrome.runtime.sendMessage({ action: 'open-tab', url: b.link }));
}

function pmSetBatchSale() {
  if (pmBusy) return;
  const items = pmSaleCandidates(pmGetBatch());
  if (!items.length) return;
  const ids = items.map(b => `#${b.bidId}`).join(', ');
  if (!confirm(`Перевести в статус «аккаунты в продаже» ${items.length} заявок?\n\n${ids}`)) return;
  pmRunBatch('sale', items, b => {
    if (!PM_REVIEW_STATUS.has(b.select.value)) return; // status changed meanwhile
    b.select.value = PM_SALE_STATUS;
    b.select.dispatchEvent(new Event('change', { bubbles: true })); // fires the page's onchange → admin_bids.change_status
  });
}

function pmRenderFilterPanel() {
  let panel = document.querySelector('.pm-filter-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'pm-filter-panel';
    document.body.appendChild(panel);
  }
  panel.innerHTML = '';

  const expandBtn = document.createElement('button');
  expandBtn.className = 'pm-filter-btn pm-filter-expand-btn';
  expandBtn.textContent = pmAllExpanded ? '▲ Свернуть' : '▼ Раскрыть';
  expandBtn.onclick = pmToggleAllDetails;
  panel.appendChild(expandBtn);

  const openBtn = document.createElement('button');
  openBtn.className = 'pm-filter-btn pm-filter-open-btn';
  openBtn.textContent = pmOpenBtnText();
  openBtn.title = `Открыть «Править значения заявки» у первых ${PM_BATCH_LIMIT} видимых заявок в новых вкладках`;
  openBtn.disabled = !!pmBusy;
  openBtn.onclick = pmOpenMacroLinks;
  panel.appendChild(openBtn);

  const saleBtn = document.createElement('button');
  saleBtn.className = 'pm-filter-btn pm-filter-sale-btn';
  saleBtn.textContent = pmSaleBtnText();
  saleBtn.title = `Перевести первые ${PM_BATCH_LIMIT} видимых заявок со статусом «на проверке» в «аккаунты в продаже»`;
  saleBtn.disabled = !!pmBusy;
  saleBtn.onclick = pmSetBatchSale;
  panel.appendChild(saleBtn);

  const sep = document.createElement('span');
  sep.className = 'pm-filter-sep';
  panel.appendChild(sep);

  const allBtn = document.createElement('button');
  allBtn.className = 'pm-filter-btn' + (!pmActiveFilters.size ? ' pm-filter-active' : '');
  allBtn.textContent = 'Все';
  allBtn.onclick = () => { pmActiveFilters.clear(); pmApplyFilter(); pmRenderFilterPanel(); };
  panel.appendChild(allBtn);

  pmKnownCats.forEach(({ name, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'pm-filter-btn' + (pmActiveFilters.has(name) ? ' pm-filter-active' : '');
    if (icon) {
      const img = document.createElement('img');
      img.src = icon; img.width = 14; img.height = 14; img.style.verticalAlign = 'middle';
      btn.appendChild(img);
      btn.appendChild(document.createTextNode(' ' + name));
    } else {
      btn.textContent = name;
    }
    btn.onclick = () => {
      pmActiveFilters.has(name) ? pmActiveFilters.delete(name) : pmActiveFilters.add(name);
      pmApplyFilter();
      pmRenderFilterPanel(); // after filter so the open-button count is current
    };
    panel.appendChild(btn);
  });

  pmObserver?.takeRecords(); // absorb our own panel mutations
}

function pmUpdateFilterPanel() {
  let changed = !document.querySelector('.pm-filter-panel');
  document.querySelectorAll('tr.tr_default.bids-tr-table-new').forEach(tr => {
    const cat = pmGetRowCategory(tr);
    if (cat && !pmKnownCats.has(cat.name)) {
      pmKnownCats.set(cat.name, cat);
      changed = true;
    }
  });
  if (changed) pmRenderFilterPanel();
  if (pmActiveFilters.size) pmApplyFilter(); // newly loaded rows
}

// ── Macro-values page (/bids/macro-values/{id}) ──────────────────────────────

function pmIsTextField(field) {
  const control = field.querySelector('.catalog-template-field-control');
  if (!control || control.querySelector('select')) return false;
  return !!control.querySelector('textarea, input[type="text"], input:not([type])');
}

function pmIsRequiredField(field) {
  return !!field.querySelector('.catalog-template-field-control [required], .catalog-template-label-text .red');
}

// Text fields first (required ones on top), then dropdowns in their original order.
function pmSortMacroFields(form) {
  const grid = form.querySelector('.catalog-template-form-grid');
  if (!grid) return;
  const fields = [...grid.querySelectorAll(':scope > .catalog-template-field')];
  const rank = f => pmIsTextField(f) ? (pmIsRequiredField(f) ? 0 : 1) : 2;
  fields
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .forEach(({ f }) => grid.appendChild(f));
}

function pmAddFloatingSave(form) {
  const realBtn = form.querySelector('.catalog-template-actions button[type="submit"], button[type="submit"]');
  if (!realBtn || document.querySelector('.pm-float-save')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pm-float-save';
  btn.textContent = '💾 ' + (realBtn.textContent.trim() || 'Сохранить');
  // requestSubmit runs native validation and the page's own submit handlers.
  btn.onclick = () => form.requestSubmit(realBtn);
  document.body.appendChild(btn);
}

function pmInitMacroValuesPage() {
  const form = document.getElementById('bid-macro-values-edit-form');
  if (!form) return;
  pmSortMacroFields(form);
  pmAddFloatingSave(form);
}

pmInitMacroValuesPage();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function pmIsMacroValuesPage() {
  return location.pathname.includes('/macro-values/') ||
    !!document.getElementById('bid-macro-values-edit-form');
}

function pmStart() {
  // The macro-values page has its own behaviour (field sorting + floating save), no filter panel.
  if (pmObserver || !pmUrlMatches() || pmIsMacroValuesPage()) return;
  pmUpdateFilterPanel();

  let timer = null;
  pmObserver = new MutationObserver((mutations) => {
    const onlyPm = mutations.every(m => m.target?.closest?.('.pm-filter-panel'));
    if (onlyPm || timer) return;
    timer = setTimeout(() => { timer = null; pmUpdateFilterPanel(); }, 150);
  });
  pmObserver.observe(document.body, { childList: true, subtree: true });
}

chrome.storage.local.get(['urlPatterns'], (r) => {
  pmUrlPatterns = r.urlPatterns || [];
  pmStart();
});

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.urlPatterns) return;
  pmUrlPatterns = changes.urlPatterns.newValue || [];
  pmStart();
});
