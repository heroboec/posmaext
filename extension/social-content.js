'use strict';

let pmSocialConfig = null;
let pmSocialConfigError = '';
let pmSocialPreparing = false;
const pmSocialPackages = new Map();
let pmSocialLastResponse = 0;
let pmSocialAdminQueue = Promise.resolve();
const pmSocialSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pmSocialMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'Нет связи с расширением');
  return result;
}
function pmSocialAvailability() {
  if (pmSocialConfigError) return { reason: `Нет связи с расширением: ${pmSocialConfigError}. Перезагрузите расширение и страницу.` };
  if (!pmSocialConfig) return { reason: 'Загружаю настройки проверки…' };
  if (pmActiveFilters.size !== 1) return { reason: 'Выберите ровно одну категорию в фильтре.' };
  const category = [...pmActiveFilters][0];
  const platform = pmSocialConfig.mapping?.[category];
  if (!platform) return { reason: `Social Check: настройте сопоставление категории «${category}» с платформой в настройках расширения.` };
  if (!pmSocialConfig.catalog?.length) return { reason: 'Social Check: каталог платформ не загружен. В настройках нажмите «Проверить связь».' };
  if (!PM_SOCIAL.types(pmSocialConfig.catalog, platform).length) return { reason: `Social Check: платформа «${platform}» недоступна для проверки профилей. В настройках нажмите «Проверить связь» и проверьте каталог сервиса.` };
  return { platform, reason: '' };
}
function pmSocialPlatform() { return pmSocialAvailability().platform || null; }
function pmSocialButton(panel) {
  const available = pmSocialAvailability();
  const button = document.createElement('button');
  button.className = 'pm-filter-btn pm-filter-social-btn';
  button.textContent = 'Подготовить проверку';
  button.title = available.reason || 'Первые 10 видимых поставок: аккаунты из разметки → ИИ → Social Check';
  button.disabled = !!pmBusy || pmSocialPreparing || !available.platform;
  button.onclick = pmSocialPrepare;
  panel.append(button);
  if (available.reason) {
    const hint = document.createElement('div');
    hint.className = 'pm-social-hint'; hint.textContent = available.reason;
    hint.setAttribute('role', 'status'); panel.append(hint);
  }
}
function pmSocialCurrent(bidId) { return pmSelectableRows().find(b => b.bidId === bidId); }
function pmSocialMetadata(item, platform) {
  const next = item.row.nextElementSibling;
  const taggedDetails = next && [...next.classList].some(c => /^tr-hidden-bid-\d+$/.test(c));
  const details = next?.classList.contains('tr-hidden-bid') &&
    (!taggedDetails || next.classList.contains(`tr-hidden-bid-${item.bidId}`)) ? next : null;
  const properties = [];
  if (details) {
    details.querySelectorAll('.bid-macro-display-row').forEach(row => {
      const label = row.querySelector('span')?.textContent.trim();
      const value = row.querySelector('.section-bids-item .field-view');
      if (label && value) properties.push({ label, value: value.dataset.value || value.textContent.trim() });
    });
    for (const [selector, label] of [['.field-view-country', 'Страна'], ['.field-view-proxy', 'Прокси'], ['.field-view-format', 'Формат']]) {
      const field = details.querySelector(selector);
      if (field && !properties.some(p => p.label.replace(/[:\s]+$/, '') === label)) properties.push({ label, value: field.dataset.value || field.textContent.trim() });
    }
  }
  const descriptionNode = item.row.querySelector(`[data-text-item="${item.bidId}"]`) || details?.querySelector(`[data-text-item="${item.bidId}"]`);
  const description = descriptionNode?.textContent.trim() || '';
  const title = item.row.querySelector('.bids-item-title')?.textContent.trim() || '';
  const format = properties.find(p => /^(формат(?:\s+(?:товара|аккаунта|данных))?|format)\s*:?\s*$/i.test(p.label))?.value || '';
  const categorySpans = item.row.querySelectorAll('[data-section-category] span');
  return { bidId: item.bidId, status: item.select.value, category: pmGetRowCategory(item.row)?.name || '',
    subcategory: (item.row.querySelector('[data-section-subcategory]')?.textContent || categorySpans[1]?.textContent || '').replace(/^[\s\\/]+/, '').trim(),
    platform, title, description, format, properties };
}
function pmSocialAccountSample(item, savedIndexes) {
  // Never read another bid's preview, the shortened visible text or arbitrary data-value.
  const current = pmSocialCurrent(item.bidId);
  if (!current || current.select.value !== item.status || item.status === '4') throw new Error('Строка или статус изменились');
  const rows = [...new Set([...current.row.querySelectorAll(`.section-accounts-js-${item.bidId} [data-account-full]`)]
    .map(node => node.getAttribute('data-account-full')).filter(value => typeof value === 'string' && value.trim()))];
  const indexes = rows.map((_, i) => i);
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  const sampleIndexes = savedIndexes || indexes.slice(0, 2);
  if (sampleIndexes.some(i => !Number.isInteger(i) || i < 0 || i >= rows.length)) throw new Error('Выбранные строки больше не доступны в разметке. Создайте новый пакет');
  return { rows: sampleIndexes.map(i => rows[i]), pageRows: rows.length, sampleIndexes };
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
  const task = pmSocialAdminQueue.then(async () => {
    await pmSocialSleep(Math.max(0, pmSocialLastResponse + Math.max(minimumInterval, pmSocialConfig?.interval || 800) - Date.now()));
    preflight?.(); return pmSocialAdminFetch(body);
  });
  pmSocialAdminQueue = task.catch(() => {}); return task;
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
  else { current.select.value = status; current.select.dataset.currentStatus = status; pmPreviousStatus.set(current.select, status); pmSyncSelection(); }
  item.status = status;
}
async function pmSocialPrepare() {
  if (pmBusy || pmSocialPreparing || document.querySelector('.pm-modal-backdrop')) return;
  pmSocialPreparing = true;
  pmBusy = { kind: 'social-preparing', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
  try {
    pmSocialConfig = await pmSocialMessage({ action: 'sc-public' });
    pmSocialConfigError = '';
    const platform = pmSocialPlatform();
    if (!platform) throw new Error(pmSocialAvailability().reason);
    const items = pmSelectableRows().filter(b => !b.row.hidden && !b.row.classList.contains('pm-hidden-by-filter') && getComputedStyle(b.row).display !== 'none')
      .slice(0, 10).map(b => pmSocialMetadata(b, platform));
    if (!items.length) return;
    const packageId = crypto.randomUUID();
    // Only compact supplier metadata is persisted; full rows travel separately and transiently.
    const run = await pmSocialMessage({ action: 'sc-auto-create', packageId, entries: items });
    pmBusy = { kind: 'social', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
    pmSocialAutomation(items, packageId, run);
  } catch (e) { alert(e.message); }
  finally {
    pmSocialPreparing = false;
    if (pmBusy?.kind === 'social-preparing') { pmBusy = null; pmRenderFilterPanel(); pmSyncSelection(); }
  }
}
function pmSocialAutomation(items, packageId, initialRun) {
  const run = initialRun;
  let closed = false, running = false;
  const states = new Map(items.map(i => [i.bidId, { state: 'pending' }]));
  const host = document.createElement('div'); host.className = 'pm-modal-backdrop';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = PM_DECLINE_DIALOG_CSS;
  root.append(style);
  const overlay = document.createElement('div'); overlay.className = 'pm-dialog-overlay';
  const dialog = document.createElement('div'); dialog.className = 'pm-modal'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  overlay.append(dialog); root.append(overlay); document.body.append(host);
  const node = (tag, text) => { const n = document.createElement(tag); n.textContent = text; dialog.append(n); return n; };
  const close = () => {
    if (closed) return; closed = true;
    if (running) pmSocialMessage({ action: 'ai-cancel', id: packageId, runId: run.runId }).catch(() => {});
    window.removeEventListener('pagehide', close);
    host.remove(); pmBusy = null; pmRenderFilterPanel(); pmSyncSelection();
  };
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') { e.preventDefault(); root.querySelector('button')?.focus(); }
  });
  window.addEventListener('pagehide', close);
  const render = () => {
    if (closed) return; dialog.replaceChildren();
    const done = [...states.values()].filter(s => ['ready', 'error'].includes(s.state)).length;
    node('h2', `Автоматическая подготовка: ${done} из ${items.length}`);
    node('p', 'Аккаунты из разметки → ИИ → Social Check. Результаты открыты в соседней вкладке. Полные строки аккаунтов здесь не отображаются и не сохраняются.');
    for (const item of items) {
      const s = states.get(item.bidId);
      node('p', `#${item.bidId} — ${s.state === 'ready' ? 'Логины определены' : s.state === 'error' ? s.error : 'Определение логинов…'}`);
    }
    const cancel = node('button', running ? 'Отмена' : 'Закрыть'); cancel.onclick = close; cancel.focus();
  };
  async function process() {
    running = true;
    for (const bid of run.ready || []) states.set(bid, { state: 'ready' });
    render();
    const queue = items.filter(i => states.get(i.bidId).state !== 'ready');
    await Promise.all(Array.from({ length: Math.min(queue.length, pmSocialConfig?.aiConcurrency || 3) }, async () => {
      while (!closed && queue.length) {
        const item = queue.shift();
        states.set(item.bidId, { state: 'pending' }); render();
        let sample;
        try {
          sample = pmSocialAccountSample(item, run.samples?.[item.bidId]);
          const response = await pmSocialMessage({ action: 'ai-extract', id: packageId, runId: run.runId, bidId: item.bidId, ...sample });
          if (!closed) states.set(item.bidId, response.count ? { state: 'ready' } : { state: 'error', error: 'Логин не определён' });
        } catch (e) {
          if (!closed) await pmSocialMessage({ action: 'ai-entry-error', id: packageId, runId: run.runId, bidId: item.bidId }).catch(() => {});
          if (!closed) states.set(item.bidId, { state: 'error', error: e.message });
        } finally { if (sample) sample.rows.length = 0; }
        render();
      }
    }));
    running = false; close();
  }
  render(); process();
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
    if (msg.command === 'prepare-auto') {
      if (pmBusy || document.querySelector('.pm-modal-backdrop')) throw new Error('Завершите подготовку в исходной вкладке');
      const items = msg.entries.map(entry => {
        const current = pmSocialCurrent(entry.bidId);
        if (!current || current.select.value !== entry.status) throw new Error('Строка или статус изменились. Сверьте статусы');
        return pmSocialMetadata(current, pmGetRowCategory(current.row) && pmSocialConfig?.mapping[pmGetRowCategory(current.row).name]);
      });
      pmBusy = { kind: 'social-preparing', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
      try {
        const run = await pmSocialMessage({ action: 'sc-auto-create', packageId: msg.packageId, entries: items });
        pmBusy = { kind: 'social', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
        pmSocialAutomation(items, msg.packageId, run); return {};
      } finally {
        if (pmBusy?.kind === 'social-preparing') { pmBusy = null; pmRenderFilterPanel(); pmSyncSelection(); }
      }
    }
    if (pmBusy || document.querySelector('.pm-modal-backdrop')) throw new Error('Завершите текущую операцию в админке');
    if (pmSocialPackages.get(msg.packageId)?.get(msg.bidId) !== msg.status) throw new Error('Нет привязки заявки к пакету');
    if (!['accept', 'decline'].includes(msg.command)) throw new Error('Неизвестное действие');
    pmBusy = { kind: 'social-decision', progress: '' }; pmRenderFilterPanel(); pmSyncSelection();
    try {
      const item = { bidId: msg.bidId, status: msg.status };
      await pmSocialChange(item, msg.command === 'accept' ? '3' : '4', msg.message || '');
      pmSocialPackages.get(msg.packageId).set(msg.bidId, item.status); return { status: item.status };
    } finally { pmBusy = null; pmRenderFilterPanel(); pmSyncSelection(); }
  })().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});
async function pmSocialLoadConfig() {
  if (!pmListEnabled()) return;
  try { pmSocialConfig = await pmSocialMessage({ action: 'sc-public' }); pmSocialConfigError = ''; }
  catch (e) { pmSocialConfigError = e.message; }
  if (pmUrlMatches()) pmRenderFilterPanel();
}
pmSocialLoadConfig();
window.addEventListener('focus', pmSocialLoadConfig);
