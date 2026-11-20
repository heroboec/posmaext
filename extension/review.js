'use strict';

let scReviewId = new URLSearchParams(location.search).get('id');
let scReviewPack, scReviewSameStore = false, scReviewBusy = false, scReviewStop = false, scReviewClosed = false, scReviewPort;
const scReviewClient = crypto.randomUUID();
const scNode = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node; };
const scNotice = text => { document.getElementById('notice').textContent = text; };
const scValue = value => value === null || value === undefined ? 'Нет данных' : String(value);
const scReasons = { profile_not_found: 'Профиль не найден', profile_private: 'Закрытый профиль', profile_unresolved: 'Профиль не удалось определить',
  unsupported_query: 'Неподдерживаемый запрос', temporarily_unavailable: 'Временно недоступно', timeout: 'Превышено время ожидания',
  invalid_response: 'Некорректный ответ источника', internal_error: 'Внутренняя ошибка' };
const scBidStatuses = { 1: 'Ожидает загрузки', 2: 'На проверке', 3: 'В продаже', 4: 'Отклонено', 5: 'Продано', 6: 'На проверке 48 ч', 7: 'На проверке 72 ч', 8: 'В обработке' };
async function scReviewMessage(message) {
  const result = await chrome.runtime.sendMessage({ id: scReviewId, client: scReviewClient, ...message });
  if (!result?.ok) throw new Error(result?.error || 'Нет связи с расширением');
  return result;
}
function scReviewConnect() {
  if (!scReviewId || scReviewClosed) return;
  scReviewPort = chrome.runtime.connect({ name: 'pm-review:' + scReviewId + ':' + scReviewClient });
  scReviewPort.onDisconnect.addListener(() => {
    if (!scReviewClosed && !scReviewStop) setTimeout(scReviewConnect, 500);
  });
}
window.addEventListener('pagehide', () => {
  scReviewClosed = true; scReviewStop = true; scReviewPort?.disconnect();
  if (scReviewPack?.auto) scReviewMessage({ action: 'ai-cancel' }).catch(() => {});
});
async function scReviewLoad() {
  const result = await scReviewMessage({ action: 'sc-get' });
  scReviewPack = result.package; scReviewSameStore = result.sameStore; scReviewRender();
}
function scReviewRender() {
  document.getElementById('controls').hidden = false;
  document.getElementById('summary').textContent = `Пакет ${scReviewPack.id} · заявок: ${scReviewPack.entries.length} · вкладка админки: ${scReviewPack.tabId}` +
    (scReviewSameStore ? '' : ' · URL/ключ магазина изменились — запросы API заблокированы');
  for (const id of ['check', 'refresh', 'sync', 'reconnect', 'delete']) document.getElementById(id).disabled = scReviewBusy || (['check', 'refresh'].includes(id) && !scReviewSameStore);
  document.getElementById('stop').disabled = !scReviewBusy;
  document.getElementById('retry-ai').hidden = !scReviewPack.auto;
  document.getElementById('retry-ai').disabled = scReviewBusy;
  if (scReviewPack.auto && !scReviewPack.aiPaused) document.getElementById('stop').disabled = false;
  const main = document.getElementById('entries'); main.replaceChildren();
  for (const entry of scReviewPack.entries) {
    const article = scNode('article', undefined, main);
    scNode('h2', `Заявка #${entry.bidId} — ${scBidStatuses[entry.status] || entry.status}`, article);
    scNode('p', `${entry.category} / ${entry.subcategory || 'Подкатегория не указана'}`, article);
    if (entry.title) scNode('h3', entry.title, article);
    const description = entry.description || entry.properties.find(p => p.label.replace(/[:\s]+$/, '') === 'Описание товара')?.value;
    scNode('p', description || 'Описание товара в разметке не найдено', article).className = 'description';
    scNode('p', `${entry.jobs.length} аккаунтов · ${entry.pageRows ?? '—'} полных строк в разметке`, article);
    if (entry.extractionState === 'pending') scNode('p', 'ИИ определяет логины… Если подготовка прервана, нажмите «Повторить извлечение».', article);
    if (entry.extractionError) scNode('p', entry.extractionError, article).className = 'error';
    if (entry.sourceStatus !== undefined && entry.sourceStatus !== entry.status) scNode('p', entry.sourceStatus === null ? 'Строка отсутствует в исходном списке' : `Конфликт: в админке статус ${scBidStatuses[entry.sourceStatus] || entry.sourceStatus}. Решение заблокировано`, article).className = 'error';
    const fields = Object.entries(PM_SOCIAL.fields).filter(([field]) =>
      !['avatar_url', 'profile_url', 'display_name', 'username', 'bio'].includes(field));
    const scroll = scNode('div', undefined, article); scroll.className = 'scroll';
    const table = scNode('table', undefined, scroll); table.className = 'accounts-table';
    const head = scNode('tr', undefined, scNode('thead', undefined, table));
    ['Логин / ID', 'Состояние', ...fields.map(([, label]) => label), 'Подробности / ошибка'].forEach(label => scNode('th', label, head));
    const body = scNode('tbody', undefined, table);
    for (const job of entry.jobs) {
      const tr = scNode('tr', undefined, body);
      scNode('td', job.query.identifier, tr).className = 'login';
      scNode('td', job.check ? PM_SOCIAL.statuses[job.check.status] || job.check.status :
        job.attempted ? 'Отправка не подтверждена' : 'Ожидает отправки', tr);
      for (const [field] of fields) scNode('td', scValue(job.check?.result?.data?.[field]), tr);
      const detail = [
        job.check?.id ? `Проверка: ${job.check.id}` : '',
        job.check?.reason ? scReasons[job.check.reason] || 'Источник не предоставил результат' : '',
        job.check?.result?.source_observed_at ? `Данные источника: ${job.check.result.source_observed_at}` : '',
        job.check?.previously_requested != null ? `Запрашивался ранее: ${job.check.previously_requested ? 'Да' : 'Нет'}` : '',
        job.error || '',
      ].filter(Boolean).join(' · ');
      scNode('td', detail || '—', tr).className = job.error ? 'error' : '';
    }
    const issues = entry.extractionIssues?.length ? entry.extractionIssues :
      !entry.jobs.length && entry.extractionError ? [entry.extractionError] : [];
    for (const issue of issues) {
      const tr = scNode('tr', undefined, body);
      scNode('td', 'Не определён', tr);
      const cell = scNode('td', issue, tr); cell.colSpan = fields.length + 2; cell.className = 'error';
    }
    scNode('h3', 'Исходные свойства поставщика', article);
    if (!entry.properties.length) scNode('p', 'В доступной разметке свойства не найдены', article);
    else {
      const props = scNode('table', undefined, article);
      entry.properties.forEach(p => { const tr = scNode('tr', undefined, props); scNode('th', p.label, tr); scNode('td', p.value, tr); });
    }
    const actions = scNode('div', undefined, article); actions.className = 'actions';
    const conflict = entry.sourceStatus !== undefined && entry.sourceStatus !== entry.status;
    const accept = scNode('button', 'Принять → В продаже', actions); accept.className = 'accept';
    accept.disabled = scReviewBusy || conflict || !['2', '6', '7'].includes(entry.status);
    accept.onclick = () => { if (confirm(`Принять заявку #${entry.bidId} и перевести в продажу?`)) scReviewDecision(entry, 'accept'); };
    const decline = scNode('button', 'Отклонить', actions); decline.className = 'decline';
    decline.disabled = scReviewBusy || conflict || entry.status === '4';
    decline.onclick = () => pmShowDeclineDialog(entry.bidId, () => { scReviewLoad().catch(e => scNotice(e.message)); }, {
      send: async message => {
        scReviewBusy = true; scReviewRender();
        try { await scReviewMessage({ action: 'sc-decision', bidId: entry.bidId, decision: 'decline', message }); }
        finally { scReviewBusy = false; scReviewRender(); }
      },
    });
  }
}
async function scReviewDecision(entry, decision) {
  scReviewBusy = true; scReviewRender();
  try { await scReviewMessage({ action: 'sc-decision', bidId: entry.bidId, decision }); scNotice('Статус подтверждён сервером'); }
  catch (e) { scNotice(e.message); }
  finally { scReviewBusy = false; await scReviewLoad(); }
}
async function scReviewQueue(action, automatic = false) {
  if (scReviewBusy || !scReviewSameStore) return;
  if (scReviewStop) scReviewConnect();
  scReviewBusy = true; scReviewStop = false; scReviewRender(); scNotice('Очередь выполняется…');
  try {
    const requests = [];
    for (const entry of scReviewPack.entries) for (let i = 0; i < entry.jobs.length; i++) {
      if (scReviewStop || scReviewClosed) break;
      const job = entry.jobs[i];
      if (action === 'sc-submit' ? job.check?.id || job.rejected : !job.check?.id) continue;
      if (automatic && (job.error || (action === 'sc-submit' ? job.attempted : !['pending', 'running'].includes(job.check?.status)))) continue;
      requests.push(scReviewMessage({ action, bidId: entry.bidId, job: i, manual: !automatic }));
    }
    const outcomes = await Promise.allSettled(requests);
    if (scReviewClosed) return;
    const failed = outcomes.filter(result => result.status === 'rejected');
    if (failed.length) throw new Error(`${failed.length} из ${outcomes.length}: ${failed[0].reason.message}`);
    scNotice(action === 'sc-submit' ? (scReviewPack.auto ? 'Отправка завершена. Результаты обновляются автоматически.' :
      'Отправка завершена. Нажмите «Обновить результаты» для получения текущих статусов.') : 'Результаты обновлены.');
  } catch (e) { scNotice(`Очередь приостановлена: ${e.message}`); }
  finally { scReviewBusy = false; if (!scReviewClosed) await scReviewLoad().catch(e => scNotice(e.message)); }
}
document.getElementById('check').onclick = () => scReviewQueue('sc-submit');
document.getElementById('refresh').onclick = () => scReviewQueue('sc-refresh');
document.getElementById('stop').onclick = () => {
  scReviewStop = true; scReviewPort?.disconnect();
  if (scReviewPack?.auto) scReviewMessage({ action: 'ai-cancel' }).catch(e => scNotice(e.message));
  scNotice('Новые запросы и извлечение остановлены. Уже принятые Social Check задания не отменяются.');
};
document.getElementById('retry-ai').onclick = async () => {
  try {
    await scReviewMessage({ action: 'sc-auto-retry' });
    scReviewStop = false; scReviewConnect(); scNotice('Повторное извлечение запущено в исходной вкладке.');
  } catch (e) { scNotice(e.message); }
};
document.getElementById('sync').onclick = async () => {
  try { await scReviewMessage({ action: 'sc-sync' }); await scReviewLoad(); scNotice('Статусы сверены'); }
  catch (e) { scNotice(e.message); }
};
document.getElementById('reconnect').onclick = async () => {
  try {
    const { tabs } = await scReviewMessage({ action: 'sc-tabs' });
    if (!tabs.length) throw new Error('Откройте список заявок на исходном сайте и повторите восстановление');
    const value = prompt('Выберите ID вкладки с заявками пакета:\n' + tabs.map(t => `${t.id}: ${t.title}`).join('\n'), String(scReviewPack.tabId));
    if (value === null) return;
    await scReviewMessage({ action: 'sc-reconnect', tabId: value }); await scReviewMessage({ action: 'sc-sync' }); await scReviewLoad(); scNotice('Связь восстановлена');
  }
  catch (e) { scNotice(e.message); }
};
document.getElementById('delete').onclick = async () => {
  if (!confirm('Удалить сохранённый пакет? Серверные проверки не отменяются.')) return;
  try { await scReviewMessage({ action: 'sc-delete' }); location.href = 'review.html'; }
  catch (e) { scNotice(e.message); }
};
async function scReviewInit() {
  const result = await scReviewMessage({ action: 'sc-list' });
  const nav = document.getElementById('packages');
  for (const pack of result.packages) {
    const a = scNode('a', `${new Date(pack.created).toLocaleString('ru')} (${pack.count})`, nav); a.href = 'review.html?id=' + encodeURIComponent(pack.id);
  }
  if (!result.packages.length) scNotice('Сохранённых пакетов нет. Начните подготовку в списке заявок.');
  if (scReviewId) { scReviewConnect(); await scReviewLoad(); await scReviewAutomatic(); }
}
scReviewInit().catch(e => scNotice(e.message));
// Source-page changes and another review tab are reflected without making API calls.
async function scReviewAutomatic() {
  if (!scReviewPack?.auto || scReviewPack.aiPaused || !scReviewSameStore || scReviewBusy || scReviewStop || scReviewClosed) return;
  const fresh = scReviewPack.entries.some(e => e.jobs.some(j => !j.attempted && !j.check?.id && !j.rejected));
  const pending = scReviewPack.entries.some(e => e.jobs.some(j => !j.error && j.check?.id && ['pending', 'running'].includes(j.check.status)));
  if (fresh || pending) await scReviewQueue(fresh ? 'sc-submit' : 'sc-refresh', true);
}
setInterval(async () => {
  if (!scReviewPack || scReviewBusy || scReviewClosed || (document.hidden && !scReviewPack.auto) || document.querySelector('.pm-modal-backdrop')) return;
  try { await scReviewMessage({ action: 'sc-sync' }); await scReviewLoad(); }
  catch (_) { /* A lost source tab does not discard already received results. */ }
  await scReviewAutomatic();
}, 2000);
