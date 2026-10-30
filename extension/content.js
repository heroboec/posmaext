'use strict';

let pmUrlPatterns = [];
const pmActiveFilters = new Set(); // selected category names
const pmKnownCats     = new Map(); // name → { name, icon }
let   pmAllExpanded   = false;
let   pmObserver      = null;
const pmSelectedBids = new Set();
const pmPreviousStatus = new WeakMap();
let pmSelectionResult = '';

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
  document.querySelectorAll('tr.bids-tr-table-new').forEach(tr => {
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
  pmSyncSelection();
}

function pmToggleAllDetails() {
  pmAllExpanded = !pmAllExpanded;
  document.querySelectorAll('tr.bids-tr-table-new:not(.pm-hidden-by-filter)').forEach(tr => {
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
  for (const tr of document.querySelectorAll('tr.bids-tr-table-new:not(.pm-hidden-by-filter)')) {
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
  pmSyncSelection();
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
  pmSyncSelection();
}

function pmOpenMacroLinks() {
  if (pmBusy || document.querySelector('.pm-modal-backdrop')) return;
  const items = pmGetBatch().filter(b => b.link);
  if (!items.length) return;
  pmRunBatch('open', items, b => chrome.runtime.sendMessage({ action: 'open-tab', url: b.link }));
}

function pmSetBatchSale() {
  if (pmBusy || document.querySelector('.pm-modal-backdrop')) return;
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
  document.querySelectorAll('tr.bids-tr-table-new').forEach(tr => {
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

// ── Decline bid from the macro-values page ───────────────────────────────────

const PM_DECLINED_STATUS = '4';
let pmDeclineReasons = [];

// Shadow DOM keeps the site's form styles out of the rejection dialog.
const PM_DECLINE_DIALOG_CSS = `
  :host { all: initial !important; position: fixed !important; inset: 0 !important;
    z-index: 2147483647 !important; display: block !important; }
  *, *::before, *::after { box-sizing: border-box; }
  .pm-dialog-overlay { position: fixed; inset: 0; display: flex; align-items: center;
    justify-content: center; padding: 16px; background: rgba(15, 23, 42, .48); }
  .pm-modal { width: 540px; max-width: 100%; max-height: calc(100dvh - 32px);
    overflow-y: auto; padding: 24px; border-radius: 12px; background: #fff;
    color: #1f2937; box-shadow: 0 16px 56px rgba(0,0,0,.24);
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .pm-modal-title { margin: 0 0 20px; font-size: 20px; font-weight: 650; line-height: 1.3; }
  .pm-reason-label { display: block; margin: 0 0 16px; font-weight: 600; }
  .pm-reason-template, .pm-modal-reason { display: block; width: 100%; margin: 6px 0 0;
    border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #1f2937;
    font: 400 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .pm-reason-template { height: 44px; padding: 0 12px; cursor: pointer; }
  .pm-modal-reason { min-height: 150px; padding: 12px; resize: vertical; }
  .pm-modal-reason::placeholder { color: #7b8492; opacity: 1; }
  .pm-reason-template:focus, .pm-modal-reason:focus { outline: 2px solid #bfdbfe;
    outline-offset: 1px; border-color: #3b82f6; }
  .pm-modal-summary { max-height: 90px; overflow-y: auto; overflow-wrap: anywhere; color: #64748b; margin: 0 0 16px; }
  .pm-modal-summary:empty { display: none; }
  .pm-modal-hint { margin: -8px 0 16px; color: #64748b; font-size: 12px; }
  .pm-modal-error { color: #b91c1c; margin: 0 0 12px; overflow-wrap: anywhere; }
  .pm-modal-error:empty { display: none; }
  .pm-modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
  button { min-height: 40px; padding: 9px 18px; border-radius: 6px;
    font: 600 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; cursor: pointer; }
  button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  .pm-modal-cancel { background: #fff; color: #374151; border: 1px solid #cbd5e1; }
  .pm-modal-cancel:hover { background: #f1f5f9; }
  .pm-modal-submit { background: #c0392b; color: #fff; border: 1px solid #c0392b; }
  .pm-modal-submit:hover { background: #a93226; }
  :disabled { opacity: .6; cursor: wait; }
  @media (max-width: 420px) { .pm-modal { padding: 18px; } .pm-modal-title { font-size: 18px; } }
`;

// Intercept only rejection on bid rows; other statuses retain the site's handler.
// Capture runs before the select's inline onchange, avoiding a second dialog/request.
function pmInitListDecline() {
  const previous = pmPreviousStatus;
  const isStatus = el => el instanceof HTMLSelectElement &&
    /^status_id\d+$/.test(el.id) &&
    (el.hasAttribute('data-current-status') || el.closest('tr.bids-tr-table-new'));
  const enabled = () => !pmIsMacroValuesPage() &&
    (pmUrlMatches() || /^\/(?:[a-z]{2}\/?)?bids(?:\/|$)/i.test(location.pathname));
  const remember = e => { if (isStatus(e.target)) previous.set(e.target, e.target.value); };
  document.addEventListener('focusin', remember, true);
  document.addEventListener('pointerdown', remember, true);
  const open = select => {
    const oldStatus = previous.get(select) || select.dataset.currentStatus ||
      [...select.options].find(o => o.defaultSelected)?.value || '';
    select.value = oldStatus;
    const bidId = select.id.slice('status_id'.length);
    pmShowDeclineDialog(bidId, message => {
      pmMarkDeclined(select, bidId, message);
      if (pmUrlMatches()) pmRenderFilterPanel();
    });
  };
  document.addEventListener('change', e => {
    const select = e.target;
    if (!enabled() || !isStatus(select)) return;
    if (select.value !== PM_DECLINED_STATUS) {
      previous.set(select, select.value);
      return;
    }
    e.stopImmediatePropagation();
    if (pmBusy) { select.value = previous.get(select) || select.dataset.currentStatus || ''; return; }
    open(select);
  }, true);
  // The page bridge also catches jQuery-triggered and direct change_status calls.
  document.addEventListener('pm-request-decline', e => {
    if (!enabled() || !isStatus(e.target)) return;
    e.preventDefault(); // tells the bridge that our dialog took over
    e.stopImmediatePropagation();
    if (!pmBusy) open(e.target);
  }, true);
}

// Selection is explicit and independent from the 10-row open/sale batches.
function pmListEnabled() {
  return !pmIsMacroValuesPage() &&
    (pmUrlMatches() || /^\/(?:[a-z]{2}\/?)?bids(?:\/|$)/i.test(location.pathname));
}

function pmSelectableRows() {
  return [...document.querySelectorAll('tr.bids-tr-table-new')].flatMap(row => {
    const select = row.querySelector('select[id^="status_id"]');
    const bidId = select?.id.match(/^status_id(\d+)$/)?.[1];
    if (!bidId) return [];
    const visible = !row.classList.contains('pm-hidden-by-filter') && !row.hidden &&
      getComputedStyle(row).display !== 'none';
    return [{ row, select, bidId, eligible: visible && select.value !== PM_DECLINED_STATUS }];
  });
}

function pmMarkDeclined(select, bidId, message) {
  select.value = PM_DECLINED_STATUS;
  select.dataset.currentStatus = PM_DECLINED_STATUS;
  pmPreviousStatus.set(select, PM_DECLINED_STATUS);
  pmSelectedBids.delete(bidId);
  const reason = select.closest('tr')?.querySelector(`.bids-edit-reason-${bidId}`);
  if (reason) {
    reason.textContent = reason.title = message;
    const section = reason.closest('.bids-section-reason');
    if (section) section.style.display = '';
  }
  pmSyncSelection();
}

function pmSyncSelection() {
  if (!pmListEnabled()) return;
  const rows = pmSelectableRows();
  const eligibleIds = new Set(rows.filter(b => b.eligible).map(b => b.bidId));
  for (const id of pmSelectedBids) if (!eligibleIds.has(id)) pmSelectedBids.delete(id);
  for (const { row, bidId, eligible } of rows) {
    let box = row.querySelector('.pm-bid-select');
    if (!box && row.cells[0]) {
      box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'pm-bid-select';
      box.setAttribute('aria-label', `Выбрать заявку #${bidId} для отклонения`);
      box.title = `Выбрать заявку #${bidId} для отклонения`;
      box.addEventListener('click', e => e.stopPropagation());
      box.addEventListener('change', e => {
        e.stopPropagation();
        if (!pmBusy) {
          box.checked ? pmSelectedBids.add(bidId) : pmSelectedBids.delete(bidId);
          pmSelectionResult = '';
        }
        pmSyncSelection();
      });
      row.cells[0].prepend(box);
    }
    if (box) { box.checked = pmSelectedBids.has(bidId); box.disabled = !!pmBusy || !eligible; }
    row.classList.toggle('pm-bid-selected', pmSelectedBids.has(bidId));
  }
  let host = document.querySelector('.pm-selection-toolbar');
  const table = rows[0]?.row.closest('table');
  if (!host && table) {
    host = document.createElement('div');
    host.className = 'pm-selection-toolbar';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { display: block; margin: 12px 0; }
      .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px;
        border: 1px solid #d7dee7; border-radius: 8px; background: #fff;
        color: #334155; font: 14px/1.4 system-ui, sans-serif; }
      button { padding: 8px 12px; min-height: 36px; border: 1px solid #cbd5e1;
        border-radius: 5px; background: white; color: #334155; font: inherit; cursor: pointer; }
      .pm-selection-decline { background: #c0392b; border-color: #c0392b; color: white; }
      button:disabled { opacity: .5; cursor: default; }
      .pm-selection-result { flex-basis: 100%; white-space: pre-wrap; }
      .pm-selection-result:empty { display: none; }
    </style><div class="bar">
      <span class="pm-selection-count"></span>
      <button type="button" class="pm-selection-all">Выбрать все видимые</button>
      <button type="button" class="pm-selection-clear">Снять выбор</button>
      <button type="button" class="pm-selection-decline">Отклонить выбранные</button>
      <span class="pm-selection-result" role="status"></span>
    </div>`;
    root.querySelector('.pm-selection-all').onclick = () => {
      if (pmBusy) return;
      pmSelectableRows().filter(b => b.eligible).forEach(b => pmSelectedBids.add(b.bidId));
      pmSelectionResult = '';
      pmSyncSelection();
    };
    root.querySelector('.pm-selection-clear').onclick = () => {
      if (pmBusy) return;
      pmSelectedBids.clear(); pmSelectionResult = ''; pmSyncSelection();
    };
    root.querySelector('.pm-selection-decline').onclick = pmDeclineSelected;
    table.before(host);
  }
  if (host) {
    const root = host.shadowRoot;
    const count = pmSelectedBids.size;
    root.querySelector('.pm-selection-count').textContent = `Выбрано: ${count}`;
    root.querySelector('.pm-selection-all').disabled = !!pmBusy || !eligibleIds.size;
    root.querySelector('.pm-selection-clear').disabled = !!pmBusy || !count;
    root.querySelector('.pm-selection-decline').disabled = !!pmBusy || !count;
    root.querySelector('.pm-selection-result').textContent = pmSelectionResult;
  }
  pmObserver?.takeRecords();
}

function pmDeclineSelected() {
  if (pmBusy || document.querySelector('.pm-modal-backdrop')) return;
  pmSyncSelection();
  let pending = pmSelectableRows().filter(b => b.eligible && pmSelectedBids.has(b.bidId))
    .map(b => ({ ...b, status: b.select.value }));
  if (!pending.length) return;
  const total = pending.length;
  let succeeded = 0;
  pmShowDeclineDialog(null, () => {}, {
    title: `Отклонить выбранные заявки (${total})`,
    summary: pending.map(b => `#${b.bidId}`).join(', '),
    send: async (message, progress) => {
      if (pmBusy) throw new Error('Дождитесь завершения текущей операции');
      pmBusy = { kind: 'decline', progress: '' };
      document.querySelectorAll('.pm-filter-open-btn, .pm-filter-sale-btn').forEach(b => { b.disabled = true; });
      pmSyncSelection();
      const failed = [], errors = [];
      try {
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          progress(`Отклоняю ${i + 1} из ${pending.length}…`);
          try {
            const current = pmSelectableRows().find(b => b.bidId === item.bidId);
            if (!current?.eligible || current.select.value !== item.status) {
              throw new Error('строка или статус изменились; проверьте заявку');
            }
            await pmDeclineBid(item.bidId, message);
            succeeded++;
            pmMarkDeclined(current.select, item.bidId, message);
          } catch (e) { failed.push(item); errors.push(`#${item.bidId}: ${e.message}`); }
          if (i < pending.length - 1) await new Promise(r => setTimeout(r, PM_BATCH_DELAY));
        }
        pending = failed; // A retry never sends successful requests again.
        pmSelectionResult = `Отклонено: ${succeeded} из ${total}.` +
          (errors.length ? ` Не удалось: ${errors.join('; ')}` : '');
      } finally {
        pmBusy = null;
        if (pmUrlMatches()) pmRenderFilterPanel();
        pmSyncSelection();
      }
      if (pending.length) throw new Error(pmSelectionResult);
    },
  });
}

function pmGetCsrf() {
  return document.querySelector('meta[name="csrf-token"]')?.content || null;
}

function pmBidIdFromForm(form) {
  const m = (form.getAttribute('action') || location.pathname).match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

// Same request the bids list sends when status is switched to "отклонено".
async function pmDeclineBid(bidId, message) {
  const csrf = pmGetCsrf();
  if (!csrf) throw new Error('не найден CSRF-токен на странице');
  const body = new URLSearchParams({ act: 'bids', do: 'change_status', bid_id: bidId, status: PM_DECLINED_STATUS, message });
  const resp = await fetch(location.origin + '/req/bids.php', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!resp.ok) throw new Error(`сервер ответил ${resp.status}`);
  if (json && (json.status === 'error' || json.error)) throw new Error(json.message || json.error || 'ошибка сервера');
  return json;
}

function pmShowDeclineDialog(bidId, onDone, options = {}) {
  if (document.querySelector('.pm-modal-backdrop')) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'pm-modal-backdrop';
  const root = backdrop.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PM_DECLINE_DIALOG_CSS;
  root.appendChild(style);
  const overlay = document.createElement('div');
  overlay.className = 'pm-dialog-overlay';
  root.appendChild(overlay);
  overlay.innerHTML = `
    <div class="pm-modal" role="dialog" aria-modal="true" aria-labelledby="pm-decline-title">
      <h2 class="pm-modal-title" id="pm-decline-title"></h2>
      <p class="pm-modal-summary"></p>
      <label class="pm-reason-label">Шаблон причины
        <select class="pm-reason-template"><option value="">Выберите причину из списка</option></select>
      </label>
      <label class="pm-reason-label">Причина отклонения (увидит партнёр)
        <textarea class="pm-modal-reason" rows="5" placeholder="Выберите шаблон выше или напишите причину вручную"></textarea>
      </label>
      <p class="pm-modal-hint">Текст можно изменить или написать свою причину.</p>
      <div class="pm-modal-error" role="alert"></div>
      <div class="pm-modal-actions">
        <button type="button" class="pm-modal-cancel">Отмена</button>
        <button type="button" class="pm-modal-submit">Отклонить</button>
      </div>
    </div>`;
  root.querySelector('.pm-modal-title').textContent = options.title || `Отклонить заявку #${bidId}`;
  root.querySelector('.pm-modal-summary').textContent = options.summary || '';
  const reason = root.querySelector('.pm-modal-reason');
  const template = root.querySelector('.pm-reason-template');
  const dialogReasons = [...pmDeclineReasons]; // Keep this open dialog stable while settings change.
  PM_REASONS.read(dialogReasons).forEach((text, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = PM_REASONS.label(text);
    option.title = text;
    template.appendChild(option);
  });
  template.onchange = () => {
    if (template.value === '') return;
    reason.value = dialogReasons[Number(template.value)];
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    reason.focus();
  };
  const errorEl = root.querySelector('.pm-modal-error');
  const submit = root.querySelector('.pm-modal-submit');
  const cancel = root.querySelector('.pm-modal-cancel');
  const previouslyFocused = document.activeElement;
  const close = () => { backdrop.remove(); previouslyFocused?.focus(); };

  const doSubmit = async () => {
    if (submit.disabled) return;
    const message = reason.value.trim();
    if (!message) { errorEl.textContent = 'Укажите причину'; reason.focus(); return; }
    errorEl.textContent = '';
    submit.disabled = cancel.disabled = reason.disabled = template.disabled = true;
    submit.textContent = 'Отправляю…';
    try {
      if (options.send) await options.send(message, text => { submit.textContent = text; });
      else await pmDeclineBid(bidId, message);
      close();
      onDone(message);
    } catch (e) {
      errorEl.textContent = options.send ? e.message : `✗ Не удалось: ${e.message}`;
      submit.disabled = cancel.disabled = reason.disabled = template.disabled = false;
      submit.textContent = options.send ? 'Повторить неудавшиеся' : 'Отклонить';
    }
  };

  submit.onclick = doSubmit;
  cancel.onclick = close;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay && !cancel.disabled) close(); });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !cancel.disabled) close();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSubmit(); }
    if (e.key === 'Tab') {
      const controls = [template, reason, cancel, submit].filter(el => !el.disabled);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.body.appendChild(backdrop);
  reason.focus();
}

function pmAddDeclineButton(form) {
  const bidId = pmBidIdFromForm(form);
  if (!bidId || document.querySelector('.pm-float-decline')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pm-float-decline';
  btn.textContent = '✗ Отклонить';
  btn.title = `Перевести заявку #${bidId} в статус «отклонено»`;
  btn.onclick = () => pmShowDeclineDialog(bidId, () => {
    btn.textContent = `✗ Заявка #${bidId} отклонена`;
    btn.disabled = true;
  });
  document.body.appendChild(btn);
}

function pmInitMacroValuesPage() {
  const form = document.getElementById('bid-macro-values-edit-form');
  if (!form) return;
  pmSortMacroFields(form);
  pmAddFloatingSave(form);
  pmAddDeclineButton(form);
}

pmInitMacroValuesPage();
pmInitListDecline();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function pmIsMacroValuesPage() {
  return location.pathname.includes('/macro-values/') ||
    !!document.getElementById('bid-macro-values-edit-form');
}

function pmStart() {
  // The macro-values page has its own behaviour (field sorting + floating save), no filter panel.
  if (pmObserver || !pmListEnabled()) return;
  if (pmUrlMatches()) pmUpdateFilterPanel();
  pmSyncSelection();

  let timer = null;
  pmObserver = new MutationObserver((mutations) => {
    const onlyPm = mutations.every(m => m.target?.closest?.('.pm-filter-panel, .pm-selection-toolbar, .pm-modal-backdrop'));
    if (onlyPm || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pmUrlMatches()) pmUpdateFilterPanel();
      pmSyncSelection();
    }, 150);
  });
  pmObserver.observe(document.body, { childList: true, subtree: true });
}

chrome.storage.local.get(['urlPatterns', 'declineReasons'], (r) => {
  pmDeclineReasons = PM_REASONS.read(r.declineReasons);
  pmUrlPatterns = r.urlPatterns || [];
  pmStart();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName && areaName !== 'local') return;
  if (changes.declineReasons) pmDeclineReasons = PM_REASONS.read(changes.declineReasons.newValue);
  if (changes.urlPatterns) {
    pmUrlPatterns = changes.urlPatterns.newValue || [];
    pmStart();
  }
});
