'use strict';

const scOption = id => document.getElementById('social-' + id);
async function scOptionsMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'Нет связи с расширением');
  return result;
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
  try {
    const result = await scOptionsMessage({ action: 'sc-test' });
    scOption('status').textContent = result.catalog.length ? `Связь есть. Каталог: ${result.catalog.map(p => `${p.platform} (${p.identifier_types.join(', ')})`).join('; ')}` : 'Связь есть, но все платформы отключены.';
  } catch (e) { scOption('status').textContent = e.message; }
  finally { scOption('test').disabled = false; }
};
scOptionsLoad().catch(e => { scOption('status').textContent = e.message; });
