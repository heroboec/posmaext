'use strict';

let scReviewId = new URLSearchParams(location.search).get('id');
let scReviewPack, scReviewSameStore = false, scReviewBusy = false, scReviewStop = false, scReviewClosed = false, scReviewPort;
const scReviewClient = crypto.randomUUID();
const scReviewJobRequests = new Map();
const scNode = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node; };
const scNotice = text => { document.getElementById('notice').textContent = text; };
const scValue = value => value === null || value === undefined ? 'Нет данных' : String(value);
function scRequestStatus(job) {
  const read = job.requestAction === 'sc-refresh', attempts = PM_SOCIAL.retryLimit + 1;
  if (job.requestState === 'queued') return read ? 'В очереди получения результата' : 'В очереди отправки · лимит 5 запросов/с';
  if (job.requestState === 'retry_wait') return `${read ? 'Повтор получения результата' : 'Повтор отправки'} через ${Math.max(0, Math.ceil((job.retryAt - Date.now()) / 1000))} с · попытка ${Math.min(attempts, (job.attemptCount || 0) + 1)}/${attempts}`;
  if (job.requestState === 'sending') return `${read ? 'Получение результата' : 'Ожидание ответа на отправку'} · попытка ${Math.max(1, job.attemptCount || 0)}/${attempts}`;
  if (job.requestState === 'failed') return job.retryable ? `${read ? 'Результат не получен' : 'Отправка не подтверждена'} — попытки исчерпаны` : 'Запрос остановлен — требуется исправить причину';
  if (job.requestState === 'paused') return 'Запрос приостановлен — требуется действие';
  if (job.check) return PM_SOCIAL.statuses[job.check.status] || job.check.status;
  if (job.attempted) return PM_SOCIAL.autoAction(job) ? 'Восстановление подтверждения с тем же ключом' : 'Отправка остановлена — см. причину';
  return 'Ожидает отправки';
}
const scRequestCauses = { network: 'Нет ответа: сеть, TLS или CORS; сторона сбоя не установлена',
  timeout: 'Таймаут ответа; сторона задержки не установлена', server: 'HTTP-ошибка Social Check или его прокси',
  rate_limit: 'Social Check ограничил частоту запросов', invalid_response: 'Некорректный ответ Social Check',
  auth: 'API-ключ или права доступа', balance: 'Баланс Social Check', api: 'Запрос отклонён API',
  local: 'Расширение или связь с исходной вкладкой' };
const scReasons = { profile_not_found: 'Профиль не найден', profile_private: 'Закрытый профиль', profile_unresolved: 'Профиль не удалось определить',
  unsupported_query: 'Неподдерживаемый запрос', temporarily_unavailable: 'Временно недоступно', timeout: 'Превышено время ожидания',
  invalid_response: 'Некорректный ответ источника', internal_error: 'Внутренняя ошибка' };
const scBidStatuses = { 1: 'Ожидает загрузки', 2: 'На проверке', 3: 'В продаже', 4: 'Отклонено', 5: 'Продано', 6: 'На проверке 48 ч', 7: 'На проверке 72 ч', 8: 'В обработке' };
async function scReviewMessage(message) {
  const result = await chrome.runtime.sendMessage({ id: scReviewId, client: scReviewClient, ...message });
  if (!result?.ok) throw new Error(result?.error || 'Нет связи с расширением');
  return result;
}
function scReviewJobRequest(action, bidId, job, manual) {
  const slot = `${bidId}:${job}`;
  if (scReviewJobRequests.has(slot)) return scReviewJobRequests.get(slot);
  const request = scReviewMessage({ action, bidId, job, manual });
  scReviewJobRequests.set(slot, request);
  const done = () => { if (scReviewJobRequests.get(slot) === request) scReviewJobRequests.delete(slot); };
  request.then(done, done);
  return request;
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
    if (entry.extractionState === 'pending') scNode('p', 'ИИ определяет логины: первая попытка и до 3 повторов. Уже найденные логины проверяются независимо. Если подготовка прервана, нажмите «Повторить извлечение».', article);
    if (entry.extractionError) scNode('p', entry.extractionError, article).className = 'error';
    if (entry.sourceStatus !== undefined && entry.sourceStatus !== entry.status) scNode('p', entry.sourceStatus === null ? 'Строка отсутствует в исходном списке' : `Конфликт: в админке статус ${scBidStatuses[entry.sourceStatus] || entry.sourceStatus}. Решение заблокировано`, article).className = 'error';
    const fields = Object.entries(PM_SOCIAL.fields).filter(([field]) =>
      !['avatar_url', 'profile_url', 'display_name', 'username', 'bio'].includes(field));
    if (entry.platform === 'reddit' || entry.jobs.some(job => job.query.platform === 'reddit')) {
      fields.push(['post_karma', 'Карма постов'], ['comment_karma', 'Карма комментариев']);
    }
    const scroll = scNode('div', undefined, article); scroll.className = 'scroll';
    const table = scNode('table', undefined, scroll); table.className = 'accounts-table';
    const head = scNode('tr', undefined, scNode('thead', undefined, table));
    ['Логин / ID', 'Состояние', ...fields.map(([, label]) => label), 'Подробности / ошибка'].forEach(label => scNode('th', label, head));
    const body = scNode('tbody', undefined, table);
    for (const job of entry.jobs) {
      const tr = scNode('tr', undefined, body);
      scNode('td', job.query.identifier, tr).className = 'login';
      scNode('td', scRequestStatus(job), tr);
      for (const [field] of fields) scNode('td', scValue(job.check?.result?.data?.[field]), tr);
      const detail = [
        job.check?.id ? `Проверка: ${job.check.id}` : '',
        job.check?.reason ? scReasons[job.check.reason] || 'Источник не предоставил результат' : '',
        job.check?.result?.source_observed_at ? `Данные источника: ${job.check.result.source_observed_at}` : '',
        job.check?.previously_requested != null ? `Запрашивался ранее: ${job.check.previously_requested ? 'Да' : 'Нет'}` : '',
        job.retryCount ? `Повторов: ${job.retryCount}/${PM_SOCIAL.retryLimit}` : '',
        job.attemptCount ? `Попыток: ${job.attemptCount}/${PM_SOCIAL.retryLimit + 1}` : '',
        job.lastHttpStatus ? `HTTP ${job.lastHttpStatus}` : '',
        scRequestCauses[job.errorKind] || '',
        job.error || '',
      ].filter(Boolean).join(' · ');
      const detailCell = scNode('td', detail || '—', tr); detailCell.className = job.error ? 'error' : '';
      if (job.error || (!job.check?.id && job.attempted && !['queued', 'sending', 'retry_wait'].includes(job.requestState))) {
        const retry = scNode('button', job.check?.id ? 'Повторить получение результата' : 'Повторить с тем же ключом', detailCell); retry.className = 'pm-request-retry';
        retry.disabled = scReviewBusy || !scReviewSameStore || job.rejected || ['queued', 'sending', 'retry_wait'].includes(job.requestState);
        retry.onclick = () => scReviewRetry(entry.bidId, entry.jobs.indexOf(job), !!job.check?.id);
      }
    }
    const issues = entry.extractionIssues?.length ? entry.extractionIssues :
      !entry.jobs.length && entry.extractionError ? [entry.extractionError] : [];
    for (const issue of issues) {
      const tr = scNode('tr', undefined, body);
      scNode('td', 'Не определён', tr);
      const cell = scNode('td', issue, tr); cell.colSpan = fields.length + 2; cell.className = 'error';
    }
    const actions = scNode('div', undefined, article); actions.className = 'actions';
    const diagnostics = scNode('button', 'Диагностика запросов', actions); diagnostics.className = 'pm-diagnostics-open';
    diagnostics.onclick = () => scReviewDiagnostics(entry);
    const conflict = entry.sourceStatus !== undefined && entry.sourceStatus !== entry.status;
    if (scReviewPack.auto && entry.extractionState !== 'pending' &&
        (entry.extractionError || entry.extractionIssues?.length || !entry.jobs.length)) {
      const manual = scNode('button', 'Выбрать столбец с логином', actions); manual.className = 'pm-manual-open';
      manual.disabled = scReviewBusy || conflict || !scReviewSameStore || entry.status === '4';
      manual.onclick = () => scReviewManual(entry);
    }
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
async function scReviewRetry(bidId, job, accepted) {
  if (scReviewBusy) return;
  if (scReviewStop) scReviewConnect();
  scReviewBusy = true; scReviewStop = false; scReviewRender();
  try {
    await scReviewJobRequest(accepted ? 'sc-refresh' : 'sc-submit', bidId, job, true);
    scNotice(accepted ? 'Ответ получен по прежнему ID проверки.' : 'Подтверждение получено с прежним ключом.');
  } catch (e) { scNotice(e.message); }
  finally { scReviewBusy = false; await scReviewLoad().catch(e => scNotice(e.message)); }
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
      const requestAction = action === 'sc-auto' ? PM_SOCIAL.autoAction(job) : action;
      if (!requestAction || (requestAction === 'sc-submit' ? job.check?.id || job.rejected : !job.check?.id)) continue;
      if (automatic && PM_SOCIAL.autoAction(job) !== requestAction) continue;
      requests.push(scReviewJobRequest(requestAction, entry.bidId, i, !automatic));
    }
    const outcomes = await Promise.allSettled(requests);
    if (scReviewClosed) return;
    const failed = outcomes.filter(result => result.status === 'rejected');
    if (failed.length) throw new Error(`${failed.length} из ${outcomes.length}: ${failed[0].reason.message}`);
    scNotice(action === 'sc-submit' ? (scReviewPack.auto ? 'Отправка завершена. Результаты обновляются автоматически.' :
      'Отправка завершена. Нажмите «Обновить результаты» для получения текущих статусов.') : 'Результаты обновлены.');
  } catch (e) { scNotice(`Часть запросов не завершилась: ${e.message}. Причина и попытки указаны в строках; остальные результаты сохранены.`); }
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
  if (scReviewPack.entries.some(e => e.jobs.some(j => PM_SOCIAL.autoAction(j)))) await scReviewQueue('sc-auto', true);
}
async function scReviewPumpReady() {
  if (!scReviewPack?.auto || scReviewPack.aiPaused ||
      !scReviewSameStore || scReviewStop || scReviewClosed) return;
  const requests = [];
  for (const entry of scReviewPack.entries) for (let i = 0; i < entry.jobs.length; i++) {
    const action = PM_SOCIAL.autoAction(entry.jobs[i]);
    if (action && !scReviewJobRequests.has(`${entry.bidId}:${i}`)) {
      requests.push(scReviewJobRequest(action, entry.bidId, i, false));
    }
  }
  if (!requests.length) return;
  try { await Promise.allSettled(requests); }
  finally {
    if (!scReviewClosed) await scReviewLoad().catch(() => {});
  }
}
let scReviewTickBusy = false;
setInterval(async () => {
  if (!scReviewPack || scReviewTickBusy || scReviewClosed || (document.hidden && !scReviewPack.auto) || document.querySelector('.pm-modal-backdrop')) return;
  scReviewTickBusy = true;
  try {
    if (!scReviewBusy) await scReviewMessage({ action: 'sc-sync' }).catch(() => {});
    // Read progress even while requests/retries are running; never start a duplicate queue.
    await scReviewLoad();
    if (scReviewBusy) scReviewPumpReady().catch(e => scNotice(e.message));
    else scReviewAutomatic().catch(e => scNotice(e.message));
  } catch (_) { /* A lost source tab does not discard already received results. */ }
  finally { scReviewTickBusy = false; }
}, 2000);
