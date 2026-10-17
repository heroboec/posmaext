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

// ── Open "Править значения заявки" links ──────────────────────────────────────

const PM_OPEN_DELAY = 700;
let   pmOpenProgress = null; // null = idle, otherwise "i/total"

function pmGetMacroLinks() {
  const urls = [];
  document.querySelectorAll('tr.tr_default.bids-tr-table-new:not(.pm-hidden-by-filter)').forEach(tr => {
    const a = tr.querySelector('a.bid-macro-values-edit-outside-link');
    if (a?.href) urls.push(a.href);
  });
  return urls;
}

function pmOpenBtnText() {
  return pmOpenProgress ? `… ${pmOpenProgress}` : `↗ Править значения (${pmGetMacroLinks().length})`;
}

async function pmOpenMacroLinks() {
  if (pmOpenProgress) return;
  const urls = pmGetMacroLinks();
  if (!urls.length) return;
  for (let i = 0; i < urls.length; i++) {
    pmOpenProgress = `${i + 1}/${urls.length}`;
    const btn = document.querySelector('.pm-filter-open-btn');
    if (btn) btn.textContent = pmOpenBtnText();
    chrome.runtime.sendMessage({ action: 'open-tab', url: urls[i] });
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, PM_OPEN_DELAY));
  }
  pmOpenProgress = null;
  pmRenderFilterPanel();
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
  openBtn.title = 'Открыть ссылки «Править значения заявки» видимых заявок в новых вкладках';
  openBtn.disabled = !!pmOpenProgress;
  openBtn.onclick = pmOpenMacroLinks;
  panel.appendChild(openBtn);

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
