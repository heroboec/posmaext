'use strict';

let pmSocialConfig = null;
let pmSocialPreparing = false;
const pmSocialPackages = new Map();
let pmSocialLastResponse = 0;
let pmSocialAdminQueue = Promise.resolve();
let pmSocialProductQueue = Promise.resolve();
let pmSocialLastProductStart = 0;
const pmSocialSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pmSocialMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'Нет связи с расширением');
  return result;
}
function pmSocialPlatform() {
  if (pmActiveFilters.size !== 1 || !pmSocialConfig) return null;
  const category = [...pmActiveFilters][0], platform = pmSocialConfig.mapping[category];
  return platform && PM_SOCIAL.types(pmSocialConfig.catalog, platform).length ? platform : null;
}
function pmSocialButton(panel) {
  if (!pmSocialPlatform()) return;
  const button = document.createElement('button');
  button.className = 'pm-filter-btn pm-filter-social-btn';
  button.textContent = 'Подготовить проверку';
  button.disabled = !!pmBusy;
  button.onclick = pmSocialPrepare;
  panel.append(button);
}
function pmSocialCurrent(bidId) { return pmSelectableRows().find(b => b.bidId === bidId); }
function pmSocialMetadata(item, platform) {
  const details = item.row.nextElementSibling?.classList.contains('tr-hidden-bid') ? item.row.nextElementSibling : null;
  const properties = [];
  if (details) {
    details.querySelectorAll('.bid-macro-display-row').forEach(row => {
      const label = row.querySelector('span')?.textContent.trim();
      const value = row.querySelector('.section-bids-item .field-view');
      if (label && value) properties.push({ label, value: value.textContent.trim() || value.dataset.value || '' });
    });
    for (const [selector, label] of [['.field-view-country', 'Страна'], ['.field-view-proxy', 'Прокси'], ['.field-view-format', 'Формат']]) {
      const field = details.querySelector(selector);
      if (field && !properties.some(p => p.label === label)) properties.push({ label, value: field.dataset.value || field.textContent.trim() });
    }
  }
  const title = item.row.querySelector('[data-text-item]') || details?.querySelector('[data-text-item]');
  if (title?.textContent.trim()) properties.unshift({ label: 'Описание товара', value: title.textContent.trim() });
  const categorySpans = item.row.querySelectorAll('[data-section-category] span');
  return { bidId: item.bidId, status: item.select.value, category: pmGetRowCategory(item.row)?.name || '',
    subcategory: (item.row.querySelector('[data-section-subcategory]')?.textContent || categorySpans[1]?.textContent || '').replace(/^[\s\\/]+/, '').trim(), platform, properties };
}
async function pmSocialAdminFetch(body) {
  const csrf = pmGetCsrf();
  if (!csrf) throw new Error('Не найден CSRF-токен. Обновите страницу админки');
    try {
      const signal = AbortSignal.timeout(30000);
      const response = await fetch(location.origin + '/req/bids.php', { method: 'POST', credentials: 'include', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(body), signal });
      if (!response.ok) throw new Error(`Админка: HTTP ${response.status}`);
      try { return await response.json(); } catch (e) {
        if (signal.aborted && signal.reason?.name === 'TimeoutError') throw signal.reason;
        if (e.name === 'TimeoutError') throw e;
        throw new Error('Админка вернула не JSON. Проверьте вход на сайт');
      }
    } finally { pmSocialLastResponse = Date.now(); }
}
function pmSocialAdmin(body, preflight, minimumInterval = 0) {
  if (body.do === 'list') {
    const start = pmSocialProductQueue.then(async () => {
      await pmSocialSleep(Math.max(0, pmSocialLastProductStart + Math.max(1000, minimumInterval, pmSocialConfig?.interval || 800) - Date.now()));
      preflight?.();
      pmSocialLastProductStart = Date.now();
      // Wrap the request so the start queue does not await the HTTP response.
      return { request: pmSocialAdminFetch(body) };
    });
    pmSocialProductQueue = start.then(() => {}, () => {});
    return start.then(({ request }) => request);
  }
  const task = pmSocialAdminQueue.then(async () => {
    await pmSocialSleep(Math.max(0, pmSocialLastResponse + Math.max(minimumInterval, pmSocialConfig?.interval || 800) - Date.now()));
    preflight?.();
    return pmSocialAdminFetch(body);
  });
  pmSocialAdminQueue = task.catch(() => {});
  return task;
}
async function pmSocialChange(item, status, message = '') {
  const current = pmSocialCurrent(item.bidId);
  if (!current || current.select.value !== item.status) throw new Error('Строка или статус изменились. Обновите связь со списком');
  if (status === '3' && !PM_REVIEW_STATUS.has(item.status)) throw new Error('Принять можно только заявку на проверке');
  if (status === '4' && (item.status === '4' || !message.trim())) throw new Error('Проверьте статус и причину');
  const json = await pmSocialAdmin({ act: 'bids', do: 'change_status', bid_id: item.bidId, status, message }, () => {
    if (pmSocialCurrent(item.bidId)?.select.value !== item.status) throw new Error('Статус изменился во время ожидания. Запрос не отправлен');
  });
  if (!PM_SOCIAL.serverSuccess(json)) throw new Error('Сервер не подтвердил смену статуса. Проверьте заявку на сайте перед повтором');
  if (status === '4') pmMarkDeclined(current.select, item.bidId, message);
  else {
    current.select.value = status; current.select.dataset.currentStatus = status;
    pmPreviousStatus.set(current.select, status); pmSyncSelection();
  }
  item.status = status;
}
async function pmSocialPrepare() {
  if (pmBusy || pmSocialPreparing || document.querySelector('.pm-modal-backdrop')) return;
  pmSocialPreparing = true;
  try {
    pmSocialConfig = await pmSocialMessage({ action: 'sc-public' });
    const platform = pmSocialPlatform();
    if (!platform) throw new Error('Выберите одну поддерживаемую категорию. Проверьте связь с API в настройках');
    let items = pmSelectableRows().filter(b => !b.row.hidden && !b.row.classList.contains('pm-hidden-by-filter') && getComputedStyle(b.row).display !== 'none')
      .slice(0, 10).map(b => ({ ...pmSocialMetadata(b, platform), rows: null, selection: null }));
    if (!items.length) return;
    const { draft } = await pmSocialMessage({ action: 'sc-draft-get' });
    let startIndex = 0, packageId = crypto.randomUUID();
    if (draft?.items[0]?.platform === platform && confirm('Есть незавершённая подготовка. Продолжить прежний набор заявок и сохранить выборку?')) {
      items = draft.items.map(item => ({ ...item, rows: null })); startIndex = draft.index; packageId = draft.packageId;
    }
    pmBusy = { kind: 'social', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
    pmSocialWizard(items, startIndex, packageId);
  } catch (e) { alert(e.message); }
  finally { pmSocialPreparing = false; }
}
function pmSocialWizard(items, startIndex = 0, packageId = crypto.randomUUID()) {
  let index = startIndex, loading = false, advancing = false, closed = false, wizardError = '';
  const host = document.createElement('div'); host.className = 'pm-modal-backdrop';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = PM_DECLINE_DIALOG_CSS + `
    .pm-modal { width: 1100px; } .scroll { overflow:auto; max-height:45vh; }
    table { border-collapse:collapse; width:100%; font-size:12px; } td,th { padding:8px; border:1px solid #cbd5e1; white-space:nowrap; }
    .chosen { background:#dbeafe; } .controls { display:flex; gap:12px; margin:16px 0; flex-wrap:wrap; }
    select { padding:8px; } .error { color:#b91c1c; } button { border:1px solid #cbd5e1; }`;
  root.append(style);
  const overlay = document.createElement('div'); overlay.className = 'pm-dialog-overlay';
  const dialog = document.createElement('div'); dialog.className = 'pm-modal'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  overlay.append(dialog); root.append(overlay); document.body.append(host);
  const element = (tag, text, parent = dialog) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; parent.append(el); return el; };
  const close = () => {
    closed = true;
    items.forEach(i => { i.rows = null; }); // Raw products/passwords never leave this in-memory wizard.
    host.remove(); pmBusy = null; pmRenderFilterPanel(); pmSyncSelection();
  };
  const button = (text, fn, parent, disabled = false) => { const b = element('button', text, parent); b.type = 'button'; b.disabled = disabled; b.onclick = fn; return b; };
  const saveDraft = () => pmSocialMessage({ action: 'sc-draft-save', packageId, index, items: items.map(item => ({
    bidId: item.bidId, status: item.status, category: item.category, subcategory: item.subcategory,
    platform: item.platform, properties: item.properties, selection: item.selection, skipped: item.skipped,
    draftColumn: item.draftColumn, draftType: item.draftType,
  })) });
  async function load(item) {
    item.queued = false; item.loading = true; item.error = '';
    if (item === items[index]) render();
    try {
      for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
        try {
          const response = await pmSocialAdmin({ do: 'list', bid_id: item.bidId, order_id: '0', mode: '0' }, () => {
            if (closed) throw new Error('Подготовка отменена');
            const current = pmSocialCurrent(item.bidId);
            if (!current || current.select.value !== item.status || item.status === '4') throw new Error('Строка или статус изменились');
          }, 1000);
          if (!closed) { item.rows = PM_SOCIAL.rows(response); item.error = ''; }
          break;
        } catch (e) {
          if (closed) break;
          if (e.name !== 'TimeoutError' || attempt === 3) throw e;
        }
      }
    } catch (e) { if (!closed) item.error = e.message; }
    finally { item.loading = false; if (!closed && item === items[index]) render(); }
  }
  async function advance(skip = false) {
    if (advancing || loading || items[index].loading || items[index].queued || closed) return;
    advancing = true; wizardError = '';
    try { await advanceInner(skip); }
    catch (e) { wizardError = e.message; }
    finally { advancing = false; if (!closed) render(); }
  }
  async function advanceInner(skip = false) {
    const item = items[index];
    if (skip) { item.skipped = true; item.selection = null; }
    else {
      const column = Number(root.querySelector('[data-column]')?.value);
      const type = root.querySelector('[data-type]')?.value;
      if (!item.selection || item.selection.column !== column || item.selection.type !== type) {
        const identifiers = PM_SOCIAL.sample(item.rows || [], column, item.platform, type);
        if (!identifiers.length) { wizardError = 'Нет корректных полных строк в выбранном столбце'; return; }
        item.selection = { column, type, identifiers, pageRows: item.rows.length };
      }
      item.skipped = false;
    }
    render();
    try { await saveDraft(); }
    catch (e) { wizardError = e.message; return; }
    if (index + 1 < items.length) { index++; await saveDraft(); render(); }
    else {
      const entries = items.filter(i => i.selection && !i.skipped && i.status !== '4').map(i => ({ ...i, rows: undefined, selection: undefined, error: undefined, ...i.selection }));
      if (!entries.length) { await pmSocialMessage({ action: 'sc-draft-delete' }); close(); return; }
      loading = true; render();
      try { await pmSocialMessage({ action: 'sc-create', packageId, entries }); await pmSocialMessage({ action: 'sc-draft-delete' }); close(); }
      catch (e) { loading = false; wizardError = e.message; render(); }
    }
  }
  function preload() {
    for (const item of items) {
      if (closed) return;
      if (!item.rows && !item.error && item.status !== '4') load(item);
    }
  }
  function render() {
    const item = items[index]; dialog.replaceChildren();
    const currentLoading = loading || item.loading || item.queued;
    element('h2', `Заявка #${item.bidId} — ${index + 1} из ${items.length}`);
    element('p', `${item.category} · ${item.subcategory || 'Подкатегория не указана'} · статус ${item.status}`);
    element('p', 'Одна страница товаров. Выберите столбец: расширение случайно возьмёт до двух различных корректных значений.');
    element('p', wizardError || item.error || (currentLoading ? 'Загрузка…' : '' )).className = 'error';
    if (item.rows && !currentLoading && item.status !== '4') {
      const width = Math.max(0, ...item.rows.map(r => r.length));
      const controls = element('div'); controls.className = 'controls';
      const label = element('label', 'Столбец ', controls), column = element('select', undefined, label); column.dataset.column = '';
      for (let i = 0; i < width; i++) { const o = element('option', String(i + 1), column); o.value = String(i); }
      column.value = String(item.draftColumn ?? item.selection?.column ?? 0);
      const typeLabel = element('label', 'Идентификатор ', controls), type = element('select', undefined, typeLabel); type.dataset.type = '';
      for (const t of PM_SOCIAL.types(pmSocialConfig.catalog, item.platform)) { const o = element('option', t === 'id' ? 'ID' : 'Юзернейм', type); o.value = t; }
      type.value = item.draftType || item.selection?.type || type.value;
      const scroll = element('div'); scroll.className = 'scroll';
      const table = element('table', undefined, scroll), header = element('tr', undefined, element('thead', undefined, table));
      for (let i = 0; i < width; i++) element('th', `Столбец ${i + 1}`, header);
      const body = element('tbody', undefined, table);
      item.rows.forEach(row => { const tr = element('tr', undefined, body); for (let i = 0; i < width; i++) element('td', row[i] ?? '—', tr); });
      const highlight = () => table.querySelectorAll('tr').forEach(tr => [...tr.children].forEach((td, i) => td.classList.toggle('chosen', i === Number(column.value))));
      column.onchange = () => { item.draftColumn = Number(column.value); highlight(); };
      type.onchange = () => { item.draftType = type.value; };
      highlight();
      if (item.selection) element('p', `Выбрано: ${item.selection.identifiers.join(', ')} (сохраняется при возврате к этому шагу)`);
    }
    const actions = element('div'); actions.className = 'controls';
    button('Назад', () => { index--; saveDraft().catch(() => {}); render(); }, actions, loading || advancing || index === 0);
    button(index === items.length - 1 ? 'Открыть результаты' : 'Далее', () => advance(), actions, currentLoading || advancing || !item.rows || item.status === '4');
    button('Пропустить', () => advance(true), actions, currentLoading || advancing);
    if (item.error) button('Повторить загрузку', () => load(item), actions, currentLoading || advancing);
    button('Отклонить заявку', () => {
      host.remove();
      let done = false;
      pmShowDeclineDialog(item.bidId, () => {
        done = true; item.rows = null; item.selection = null; item.skipped = true;
        document.body.append(host); advance(true);
      }, { send: message => pmSocialChange(item, '4', message), onClose: () => {
        // Success callback follows close synchronously; cancellation only restores the wizard.
        queueMicrotask(() => { if (!done && !closed) { document.body.append(host); render(); } });
      } });
    }, actions, currentLoading || advancing || item.status === '4');
    button('Отмена', close, actions, loading || advancing);
    actions.querySelector('button:not(:disabled)')?.focus();
  }
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !loading && !advancing) close();
    if (e.key === 'Tab') {
      const controls = [...root.querySelectorAll('button:not(:disabled),select')], first = controls[0], last = controls.at(-1);
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  items.forEach(item => { item.queued = !item.rows && !item.error && item.status !== '4'; });
  render(); saveDraft().catch(() => {}); preload();
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.action !== 'sc-source' || sender.id !== chrome.runtime.id) return;
  (async () => {
    if (!pmListEnabled() || location.origin !== msg.origin || !Array.isArray(msg.entries)) throw new Error('Исходная страница не совпадает');
    if (msg.command === 'bind') {
      if (!msg.entries.some(e => pmSocialCurrent(e.bidId))) throw new Error('Заявок пакета нет в этом списке');
      pmSocialPackages.set(msg.packageId, new Map(msg.entries.map(e => [e.bidId, e.status]))); return {};
    }
    if (msg.command === 'snapshot') return { entries: msg.entries.map(e => ({ bidId: e.bidId, status: pmSocialCurrent(e.bidId)?.select.value ?? null })) };
    if (pmBusy || document.querySelector('.pm-modal-backdrop')) throw new Error('Завершите текущую операцию в админке');
    if (pmSocialPackages.get(msg.packageId)?.get(msg.bidId) !== msg.status) throw new Error('Нет привязки заявки к пакету');
    if (!['accept', 'decline'].includes(msg.command)) throw new Error('Неизвестное действие');
    pmBusy = { kind: 'social-decision', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
    try {
      const item = { bidId: msg.bidId, status: msg.status };
      await pmSocialChange(item, msg.command === 'accept' ? '3' : '4', msg.message || '');
      pmSocialPackages.get(msg.packageId).set(item.bidId, item.status);
      return { status: item.status };
    } finally { pmBusy = null; pmRenderFilterPanel(); pmSyncSelection(); }
  })().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});
if (pmListEnabled()) pmSocialMessage({ action: 'sc-public' }).then(config => {
  pmSocialConfig = config; if (pmUrlMatches()) pmRenderFilterPanel();
}).catch(() => {});
// Refresh public capabilities when returning from settings, without accessing the API key.
window.addEventListener('focus', () => {
  if (!pmListEnabled()) return;
  pmSocialMessage({ action: 'sc-public' }).then(config => { pmSocialConfig = config; if (pmUrlMatches()) pmRenderFilterPanel(); }).catch(() => {});
});
