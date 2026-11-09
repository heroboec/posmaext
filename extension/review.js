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
window.addEventListener('pagehide', () => { scReviewClosed = true; scReviewStop = true; scReviewPort?.disconnect(); });
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
  const main = document.getElementById('entries'); main.replaceChildren();
  for (const entry of scReviewPack.entries) {
    const article = scNode('article', undefined, main);
    scNode('h2', `Заявка #${entry.bidId} — ${scBidStatuses[entry.status] || entry.status}`, article);
    scNode('p', `${entry.category} / ${entry.subcategory || 'Подкатегория не указана'}`, article);
    scNode('p', `Столбец ${entry.column + 1} · ${entry.type === 'id' ? 'ID' : 'Юзернейм'} · ${entry.jobs.length} из ${entry.pageRows} строк одной страницы`, article);
    if (entry.sourceStatus !== undefined && entry.sourceStatus !== entry.status) scNode('p', entry.sourceStatus === null ? 'Строка отсутствует в исходном списке' : `Конфликт: в админке статус ${scBidStatuses[entry.sourceStatus] || entry.sourceStatus}. Решение заблокировано`, article).className = 'error';
    const checks = scNode('div', undefined, article); checks.className = 'checks';
    entry.jobs.forEach((job, i) => {
      const card = scNode('section', undefined, checks); card.className = 'check';
      scNode('h3', `Аккаунт ${i + 1}: ${job.query.identifier}`, card);
      scNode('p', job.check ? PM_SOCIAL.statuses[job.check.status] : job.attempted ? 'Отправка не подтверждена' : 'Ещё не отправлен', card);
      if (job.check?.id) scNode('p', `Проверка: ${job.check.id}`, card);
      if (job.check?.reason) scNode('p', scReasons[job.check.reason] || 'Источник не предоставил результат', card);
      if (job.check?.previously_requested !== null && job.check?.previously_requested !== undefined) scNode('p', `Запрашивался ранее: ${job.check.previously_requested ? 'Да' : 'Нет'}`, card);
      if (job.check?.result?.source_observed_at) scNode('p', `Данные источника: ${job.check.result.source_observed_at}`, card);
      if (job.error) scNode('p', job.error, card).className = 'error';
      scNode('h4', 'Сравнение с описанием поставщика', card);
      const scroll = scNode('div', undefined, card); scroll.className = 'scroll';
      const table = scNode('table', undefined, scroll), head = scNode('tr', undefined, scNode('thead', undefined, table));
      ['Свойство', 'Заявлено поставщиком', 'Данные аккаунта'].forEach(t => scNode('th', t, head));
      const body = scNode('tbody', undefined, table);
      // Both accounts use supplier claims independently, never each other's results.
      // Only exact, unique labels are matched. Everything else remains below verbatim.
      for (const [field, label] of Object.entries(PM_SOCIAL.fields)) {
        const matching = entry.properties.filter(p => p.label.replace(/:$/, '').trim().toLocaleLowerCase('ru') === label.toLocaleLowerCase('ru'));
        const property = matching.length === 1 ? matching[0] : null;
        const tr = scNode('tr', undefined, body);
        [label, property ? property.value : 'Не сопоставлено', scValue(job.check?.result?.data?.[field])].forEach(v => scNode('td', v, tr));
      }
    });
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
async function scReviewQueue(action) {
  if (scReviewBusy || !scReviewSameStore) return;
  if (scReviewStop) scReviewConnect();
  scReviewBusy = true; scReviewStop = false; scReviewRender(); scNotice('Очередь выполняется…');
  try {
    for (const entry of scReviewPack.entries) for (let i = 0; i < entry.jobs.length; i++) {
      if (scReviewStop || scReviewClosed) return;
      const job = entry.jobs[i];
      if (action === 'sc-submit' ? job.check?.id || job.rejected : !job.check?.id) continue;
      await scReviewMessage({ action, bidId: entry.bidId, job: i });
      await scReviewLoad();
    }
    scNotice(action === 'sc-submit' ? 'Отправка завершена. Нажмите «Обновить результаты» для получения текущих статусов.' : 'Результаты обновлены.');
  } catch (e) { scNotice(`Очередь приостановлена: ${e.message}`); }
  finally { scReviewBusy = false; if (!scReviewClosed) await scReviewLoad().catch(e => scNotice(e.message)); }
}
document.getElementById('check').onclick = () => scReviewQueue('sc-submit');
document.getElementById('refresh').onclick = () => scReviewQueue('sc-refresh');
document.getElementById('stop').onclick = () => { scReviewStop = true; scReviewPort?.disconnect(); scNotice('Очередь остановится после текущего запроса.'); };
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
  if (scReviewId) { scReviewConnect(); await scReviewLoad(); }
}
scReviewInit().catch(e => scNotice(e.message));
// Source-page changes and another review tab are reflected without making API calls.
setInterval(async () => {
  if (!scReviewPack || scReviewBusy || document.hidden || document.querySelector('.pm-modal-backdrop')) return;
  try { await scReviewMessage({ action: 'sc-sync' }); await scReviewLoad(); }
  catch (_) { /* A lost source tab does not discard already received results. */ }
}, 5000);
