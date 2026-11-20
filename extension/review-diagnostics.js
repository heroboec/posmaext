'use strict';

// A separate optional overlay: opening/refreshing it never changes the check queue.
function scReviewDiagnostics(entry) {
  document.querySelector('.pm-diagnostics-backdrop')?.remove();
  const previousFocus = document.activeElement;
  const host = document.createElement('div'); host.className = 'pm-diagnostics-backdrop';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = PM_DECLINE_DIALOG_CSS + `
    .pm-modal { width:1100px; max-height:90vh; overflow:auto; font-weight:400; }
    .tools { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
    button,select { padding:8px; border:1px solid #cbd5e1; border-radius:6px; font:inherit; }
    select { max-width:100%; } .warning { color:#805600; } .error { color:#b91c1c; }
    details { margin:10px 0; border:1px solid #dbe2ed; border-radius:6px; padding:8px; }
    summary { cursor:pointer; overflow-wrap:anywhere; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:45vh; overflow:auto;
      background:#f5f7fb; padding:12px; font:12px/1.5 ui-monospace,monospace; }
  `;
  root.append(style);
  const overlay = document.createElement('div'); overlay.className = 'pm-dialog-overlay';
  const dialog = document.createElement('div'); dialog.className = 'pm-modal';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'diagnostics-title');
  overlay.append(dialog); root.append(overlay); document.body.append(host);
  const title = scNode('h2', `Диагностика заявки #${entry.bidId}`, dialog); title.id = 'diagnostics-title';
  scNode('p', 'Здесь могут быть пароли, cookies и другие данные аккаунтов. Не публикуйте их. Диагностика только в памяти: до часа, в пределах 16 МБ, после перезапуска фоновой части расширения исчезает. Окно не останавливает проверки.', dialog).className = 'warning';
  const tools = scNode('div', undefined, dialog); tools.className = 'tools';
  const label = scNode('label', 'Показать: ', tools);
  const select = scNode('select', undefined, label); select.className = 'pm-diagnostics-select';
  const refresh = scNode('button', 'Обновить диагностику', tools); refresh.className = 'pm-diagnostics-refresh';
  const closeButton = scNode('button', 'Закрыть', tools); closeButton.className = 'pm-diagnostics-close';
  const status = scNode('p', '', dialog); status.setAttribute('role', 'status');
  const content = scNode('div', undefined, dialog);
  function choices(rows = [], value = 'all') {
    select.replaceChildren();
    const all = scNode('option', 'Вся поставка', select); all.value = 'all';
    const current = scReviewPack?.entries.find(e => e.bidId === entry.bidId) || entry;
    current.jobs.forEach((job, i) => {
      const option = scNode('option', `Аккаунт: ${job.query.identifier}`, select); option.value = `job:${i}`;
    });
    for (const row of rows) {
      const option = scNode('option', `Строка ${row.index + 1} · ${new Date(row.time).toLocaleTimeString('ru-RU')}`, select);
      option.value = `row:${row.id}`;
    }
    select.value = value;
    if (select.selectedIndex < 0) {
      const old = scNode('option', 'Выбранные данные больше не доступны', select); old.value = value; select.value = value;
    }
  }
  function close() { host.remove(); if (previousFocus?.isConnected) previousFocus.focus(); }
  closeButton.onclick = close;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const controls = [...root.querySelectorAll('button:not(:disabled),select:not(:disabled),summary')].filter(el => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (p.tagName === 'DETAILS' && !p.open && el !== p.querySelector('summary')) return false;
        }
        return true;
      });
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  function detail(parent, key, heading, text, expanded) {
    const details = scNode('details', undefined, parent); details.dataset.key = key; details.open = expanded.has(key);
    scNode('summary', heading, details);
    scNode('pre', text, details);
    return details;
  }
  function render(data) {
    const expanded = new Set([...content.querySelectorAll('details[open]')].map(el => el.dataset.key));
    content.replaceChildren();
    const current = scReviewPack?.entries.find(e => e.bidId === entry.bidId) || entry;
    if (current.extractionError) scNode('p', `Ошибка подготовки: ${current.extractionError}`, content).className = 'error';
    const jobs = select.value.startsWith('job:') ? [current.jobs[Number(select.value.slice(4))]].filter(Boolean) : current.jobs;
    for (const job of jobs) if (job.error) scNode('p', `${job.query.identifier}: ${job.error}`, content).className = 'error';
    if (!data.available) {
      scNode('p', 'Для выбранных данных диагностики нет. Проверка могла выполняться до обновления или временная память расширения уже очищена. Открытие этого окна не запускает запросы повторно.', content);
      return;
    }
    if (data.truncated) scNode('p', 'Часть старой диагностики удалена из ограниченного кеша памяти.', content).className = 'warning';
    scNode('h3', `Оцениваемые строки (${data.rows.length})`, content);
    if (!data.rows.length) scNode('p', 'Исходные строки для выбранных данных в памяти не сохранились.', content);
    for (const row of data.rows) detail(content, `row:${row.id}`,
      `Строка ${row.index + 1} · ${new Date(row.time).toLocaleTimeString('ru-RU')}`, row.value, expanded);
    for (const [kind, heading] of [['ai','Ответы ИИ'], ['social','Ответы Social Check']]) {
      scNode('h3', `${heading} (${data[kind].length})`, content);
      for (const call of data[kind]) {
        const details = scNode('details', undefined, content); details.dataset.key = `call:${call.id}`;
        details.open = expanded.has(details.dataset.key);
        scNode('summary', `Попытка ${call.attempt} · HTTP ${call.status ?? 'нет ответа'}${call.query?.identifier ? ' · ' + call.query.identifier : ''}${call.error ? ' · ' + call.error : ''}`, details);
        scNode('p', `${call.method} ${call.endpoint} · ${new Date(call.time).toLocaleString('ru-RU')}` +
          (call.ended ? ` · ${Math.max(0, call.ended - call.time)} мс` : ' · запрос ещё выполняется'), details);
        if (call.retryAfter) scNode('p', `Retry-After: ${call.retryAfter}`, details);
        if (call.errors?.length || call.error) detail(details, `errors:${call.id}`, 'Ошибки обращения',
          JSON.stringify(call.errors || [{ message: call.error }], null, 2), expanded);
        detail(details, `request:${call.id}`, 'Параметры и индексы запроса (полные строки раскрываются отдельно)',
          JSON.stringify(call.request || call.query || {}, null, 2), expanded);
        if (kind === 'ai' && call.body) {
          try {
            const reply = JSON.parse(call.body)?.choices?.[0]?.message?.content;
            if (typeof reply === 'string') detail(details, `reply:${call.id}`, 'Ответ модели', reply, expanded);
          } catch (_) { /* The full malformed HTTP body is available below. */ }
        }
        if (typeof call.body === 'string') detail(details, `body:${call.id}`,
          call.truncated ? 'Ответ HTTP (обрезан в кеше)' : 'Полный ответ HTTP', call.body, expanded);
        else scNode('p', call.error ? 'Тело ответа не получено.' : 'Ожидание ответа…', details);
        if (call.truncated) scNode('p', `Слишком большой ответ обрезан в диагностике: ${call.originalLength} символов.`, details).className = 'warning';
      }
    }
  }
  let loading = false;
  async function load() {
    if (loading) return;
    loading = true; refresh.disabled = true; select.disabled = true; status.textContent = 'Читаю диагностику из памяти…';
    const value = select.value || 'all';
    try {
      const filter = value.startsWith('job:') ? { job: Number(value.slice(4)) } :
        value.startsWith('row:') ? { rowId: Number(value.slice(4)) } : {};
      const result = await scReviewMessage({ action: 'sc-diagnostics', bidId: entry.bidId, ...filter });
      if (!host.isConnected) return;
      choices(result.diagnostics.rowChoices, value); render(result.diagnostics);
      status.textContent = 'Показана текущая диагностика. Новые обращения появятся по кнопке «Обновить диагностику».';
    } catch (e) { if (host.isConnected) { status.textContent = e.message; status.className = 'error'; } }
    finally { loading = false; refresh.disabled = false; select.disabled = false; }
  }
  choices(); select.onchange = load; refresh.onclick = load;
  closeButton.focus(); load();
}
