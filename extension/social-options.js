'use strict';

const scOption = id => document.getElementById('social-' + id);
async function scOptionsMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Object.assign(new Error(result?.error || 'Нет связи с расширением'), { stage: result?.stage });
  return result;
}
const scTestStages = {
  state: 'Ожидание фонового обработчика',
  queue: 'Ожидание общей очереди API; запрос ещё не отправлен',
  cooldown: 'Сохранённая пауза после ошибки API; запрос ещё не отправлен',
  rate: 'Ожидание лимита частоты API; запрос ещё не отправлен',
  config: 'Чтение сохранённых настроек',
  permission: 'Проверка разрешения на адрес API',
  response: 'Запрос отправлен; ожидание ответа API (таймаут 30 с)',
  json: 'Чтение и разбор ответа API',
};
function scTestProgressText(test) {
  if (!test || !scTestStages[test.stage]) return null;
  const seconds = Math.max(0, Math.ceil(((test.waitUntil || 0) - Date.now()) / 1000));
  return `${scTestStages[test.stage]}${seconds ? ` · ещё ${seconds} с` : ''}`;
}
async function scOptionsLoad() {
  const config = await scOptionsMessage({ action: 'sc-config-get' });
  scOption('url').value = config.url;
  scOption('interval').value = config.interval;
  scOption('mapping').value = Object.entries(config.mapping).map(([category, platform]) => `${category} = ${platform}`).join('\n');
  scOption('key-state').textContent = config.hasKey ? 'Ключ сохранён. Пустое поле сохранит его только для прежнего адреса. При смене адреса введите ключ заново.' : 'Ключ пока не задан.';
  scOption('save').disabled = false;
}
scOption('save').onclick = async () => {
  try {
    const url = new URL(scOption('url').value.trim());
    const mapping = {};
    for (const line of scOption('mapping').value.split(/\r?\n/).filter(s => s.trim())) {
      const parts = line.split('=').map(s => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1] || Object.hasOwn(mapping, parts[0])) throw new Error('Неверная или повторная пара категории');
      Object.defineProperty(mapping, parts[0], { value: parts[1], enumerable: true });
    }
    // Must originate in this user gesture, not in the service worker.
    if (!await chrome.permissions.request({ origins: [url.origin + '/*'] })) throw new Error('Доступ к адресу API не разрешён');
    scOption('save').disabled = true;
    await scOptionsMessage({ action: 'sc-config-save', config: { url: url.href, key: scOption('key').value.trim(),
      clearKey: scOption('clear-key').checked, interval: scOption('interval').value, mapping } });
    scOption('key').value = ''; scOption('clear-key').checked = false;
    await scOptionsLoad();
    scOption('status').textContent = 'Сохранено. Нажмите «Проверить связь» и вернитесь в админку.';
  } catch (e) { scOption('status').textContent = e.message; }
  finally { scOption('save').disabled = false; }
};
scOption('test').onclick = async () => {
  scOption('test').disabled = true;
  scOption('status').textContent = 'Проверяю…';
  let finished = false, polling = false, lastStatusAt = Date.now();
  const poll = setInterval(async () => {
    if (!finished && Date.now() - lastStatusAt > 5000) {
      scOption('status').textContent = 'Фоновый обработчик не сообщает этап проверки более 5 с. Проверьте ошибки Position Matcher на chrome://extensions.';
    }
    if (polling) return;
    polling = true;
    try {
      const result = await scOptionsMessage({ action: 'sc-test-status' });
      lastStatusAt = Date.now();
      const text = scTestProgressText(result.test);
      if (!finished && text) scOption('status').textContent = text;
    } catch (_) {
      if (!finished) scOption('status').textContent = 'Нет связи с фоновым обработчиком расширения. Откройте chrome://extensions и проверьте ошибки Position Matcher.';
    } finally { polling = false; }
  }, 1000);
  try {
    const result = await scOptionsMessage({ action: 'sc-test' });
    scOption('status').textContent = result.catalog.length ? `Связь есть. Каталог: ${result.catalog.map(p => `${p.platform} (${p.identifier_types.join(', ')})`).join('; ')}` : 'Связь есть, но все платформы отключены.';
  } catch (e) {
    scOption('status').textContent = `${e.message}${scTestStages[e.stage] ? ` · Этап: ${scTestStages[e.stage]}` : ''}`;
  } finally {
    finished = true; clearInterval(poll); scOption('test').disabled = false;
  }
};
scOptionsLoad().catch(e => { scOption('status').textContent = e.message; });
