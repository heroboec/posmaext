'use strict';

async function scReviewManual(entry) {
  if (document.querySelector('.pm-modal-backdrop')) return;
  const previousFocus = document.activeElement;
  const host = document.createElement('div'); host.className = 'pm-modal-backdrop';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = PM_DECLINE_DIALOG_CSS + `
    .pm-modal { width:1100px; max-height:90vh; overflow:auto; font-weight:400; }
    .tools { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin:12px 0; }
    select,button { font:inherit; padding:8px; } .warning { color:#805600; } .error { color:#b91c1c; }
    .scroll { overflow:auto; max-height:40vh; } table { border-collapse:collapse; }
    th,td { border:1px solid #cbd5e1; padding:8px; min-width:120px; max-width:260px; overflow-wrap:anywhere; }
    .selected { background:#e0f2fe; } `;
  const overlay = document.createElement('div'); overlay.className = 'pm-dialog-overlay';
  const dialog = document.createElement('div'); dialog.className = 'pm-modal';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'manual-title');
  overlay.append(dialog); root.append(style, overlay); document.body.append(host);
  scNode('h2', `Выбор столбца · заявка #${entry.bidId}`, dialog).id = 'manual-title';
  scNode('p', 'Здесь показаны данные аккаунтов, включая возможные пароли и cookies. Не публикуйте их. Выбирайте именно публичный логин, не почту или пароль.', dialog).className = 'warning';
  scNode('p', 'Выбор применяется ко всем ещё нераспознанным строкам этой поставки. Уже найденные логины и проверки не изменяются. ИИ не вызывается; новые логины будут проверены Social Check автоматически, если очередь не приостановлена (проверки могут быть платными).', dialog);
  const status = scNode('p', 'Читаю полные строки из исходной вкладки…', dialog); status.setAttribute('role', 'status');
  const tools = scNode('div', undefined, dialog); tools.className = 'tools';
  const field = text => scNode('select', undefined, scNode('label', text + ' ', tools));
  const delimiter = field('Разделитель'); delimiter.className = 'pm-manual-delimiter';
  for (const [value, text] of [[':', 'Двоеточие :'], [';', 'Точка с запятой ;'], ['|', 'Вертикальная черта |'], ['\t', 'Табуляция']]) {
    scNode('option', text, delimiter).value = value;
  }
  const type = field('Способ поиска'); type.className = 'pm-manual-type';
  const column = field('Столбец с логином'); column.className = 'pm-manual-column';
  const preview = scNode('div', undefined, dialog); preview.className = 'scroll';
  const count = scNode('p', '', dialog);
  const buttons = scNode('div', undefined, dialog); buttons.className = 'tools';
  const apply = scNode('button', 'Сохранить выбранные логины', buttons); apply.className = 'pm-manual-apply'; apply.disabled = true;
  const cancel = scNode('button', 'Отмена', buttons); cancel.className = 'pm-manual-cancel';
  let data, saving = false;
  function close() {
    if (saving) return;
    data = undefined; host.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  cancel.onclick = close;
  overlay.onmousedown = e => { if (e.target === overlay) close(); };
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const controls = [...root.querySelectorAll('button:not(:disabled),select:not(:disabled)')];
      if (e.shiftKey && root.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
      else if (!e.shiftKey && root.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
    }
  });
  function render(reset = false) {
    if (!data) return;
    const rows = data.rows.map(row => row.value.split(delimiter.value));
    const width = Math.min(1001, rows.reduce((max, row) => Math.max(max, row.length), 0));
    if (reset) {
      column.replaceChildren(); scNode('option', 'Выберите столбец', column).value = '';
      for (let i = 0; i < width; i++) scNode('option', `Столбец ${i + 1}`, column).value = String(i);
    }
    preview.replaceChildren();
    const table = scNode('table', undefined, preview);
    const head = scNode('tr', undefined, scNode('thead', undefined, table));
    scNode('th', 'Исходная строка', head);
    for (let i = 0; i < width; i++) {
      const th = scNode('th', `Столбец ${i + 1}`, head);
      if (column.value === String(i)) th.className = 'selected';
    }
    const body = scNode('tbody', undefined, table);
    rows.slice(0, 10).forEach((row, i) => {
      const tr = scNode('tr', undefined, body); scNode('td', String(data.rows[i].index + 1), tr);
      for (let j = 0; j < width; j++) {
        const value = row[j] || '';
        const cell = scNode('td', value.length > 160 ? value.slice(0, 160) + '…' : value, tr);
        if (column.value === String(j)) cell.className = 'selected';
      }
    });
    const values = data.rows.map(row => row.value);
    const selection = column.value === '' ? [] : PM_SOCIAL.manualColumn(values, values.map((_, i) => i),
      delimiter.value, Number(column.value), data.platform, type.value);
    const valid = selection.filter(row => row.identifier).length;
    count.textContent = `Предпросмотр первых ${Math.min(10, rows.length)} из ${rows.length} нераспознанных строк; длинные поля сокращены. ` +
      (column.value === '' ? 'Выберите столбец.' : `Корректных значений: ${valid}; останутся нераспознанными: ${rows.length - valid}. Формат не отличает пароль от ника — проверьте выбор.`);
    apply.disabled = !valid;
  }
  delimiter.onchange = () => render(true); column.onchange = type.onchange = () => render();
  apply.onclick = async () => {
    if (!data || saving || apply.disabled) return;
    saving = true; apply.disabled = cancel.disabled = delimiter.disabled = column.disabled = type.disabled = true;
    try {
      const result = await scReviewMessage({ action: 'ai-manual-apply', bidId: entry.bidId, digest: data.digest, runId: data.runId,
        delimiter: delimiter.value, column: Number(column.value), type: type.value });
      saving = false; close();
      scNotice(`Добавлено логинов: ${result.added}. Осталось нераспознанных строк: ${result.remaining}.`);
      await scReviewLoad();
    } catch (e) {
      if (host.isConnected) { status.textContent = e.message; status.className = 'error'; }
      else scNotice(e.message);
    }
    finally {
      saving = false; cancel.disabled = delimiter.disabled = column.disabled = type.disabled = false;
      if (host.isConnected) render();
    }
  };
  cancel.focus();
  try {
    const result = await scReviewMessage({ action: 'ai-manual-preview', bidId: entry.bidId });
    if (!host.isConnected) return;
    data = result;
    for (const value of data.types) scNode('option', value === 'username' ? 'Логин' : 'ID', type).value = value;
    status.textContent = 'Разделитель применяется буквально. Двоеточия внутри URL и cookies тоже разделяют столбцы: проверьте предпросмотр.';
    render(true);
  } catch (e) { if (host.isConnected) { status.textContent = e.message; status.className = 'error'; } }
}
