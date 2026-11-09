'use strict';

const scDefaultConfig = { url: 'https://216.57.104.188/', key: '', interval: 800, mapping: PM_SOCIAL.defaults };
let scSerial = Promise.resolve();
const scLive = new Map();
const scSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scPage = (sender, page) => sender.url?.split('?')[0] === chrome.runtime.getURL(page);
const scTrusted = sender => scPage(sender, 'options.html') || scPage(sender, 'review.html');
async function scConfig() { return { ...scDefaultConfig, ...await PM_DB.get('config') }; }
async function scBinding(config) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.url + '\n' + config.key));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function scPackage(id) {
  const pack = await PM_DB.get('package:' + id);
  if (!pack) throw new Error('Пакет не найден');
  return pack;
}
async function scSave(pack) { await PM_DB.set('package:' + pack.id, pack); }
function scAssertLive(id) {
  if (id && !scLive.get(id)?.size) throw new Error('Очередь приостановлена: страница результатов закрыта');
}
async function scApi(path, { method = 'GET', query, key, owner } = {}) {
  const config = await scConfig();
  if (!config.key) throw new Error('Укажите API-ключ в настройках');
  if (!await chrome.permissions.contains({ origins: [new URL(config.url).origin + '/*'] })) {
    throw new Error('Нет разрешения на доступ к серверу. Сохраните настройки Social Check');
  }
  const limit = await PM_DB.get('api-limit') || { next: 0, failures: 0 };
  await scSleep(Math.max(0, limit.next - Date.now()));
  scAssertLive(owner);
  // Persist the reservation before starting the request, including across worker restarts.
  limit.next = Date.now() + 2500;
  await PM_DB.set('api-limit', limit);
  let response;
  try {
    response = await fetch(new URL('api/v1/' + path, config.url).href, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + config.key, ...(query ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
      ...(query ? { body: JSON.stringify(query) } : {}), signal: AbortSignal.timeout(30000),
    });
  } catch (_) {
    limit.failures++;
    limit.next = Date.now() + Math.min(60000, 2500 * 2 ** Math.min(limit.failures, 5));
    await PM_DB.set('api-limit', limit);
    throw new Error('Сетевой сбой. Результат отправки неизвестен; повтор использует прежний ключ');
  }
  if (response.status === 429 || response.status >= 500) {
    limit.failures++;
    const header = response.headers.get('Retry-After');
    const retry = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now()) || 0;
    limit.next = Date.now() + Math.max(2500, retry, Math.min(60000, 2500 * 2 ** Math.min(limit.failures, 5)));
  } else limit.failures = 0;
  await PM_DB.set('api-limit', limit);
  if (!response.ok) {
    const messages = { 400: 'API отклонил параметры', 401: 'Неверный API-ключ', 402: 'Недостаточно средств',
      403: 'Доступ запрещён', 409: 'Конфликт ключа идемпотентности', 429: 'Лимит API: повторите позднее', 503: 'Биллинг временно недоступен' };
    const error = new Error(messages[response.status] || `API: HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  let json;
  try { json = await response.json(); } catch (_) { throw new Error('API вернул некорректный JSON; повторите с прежним ключом'); }
  return json;
}
function scCleanEntry(entry) {
  if (!/^\d+$/.test(entry.bidId) || !Object.values(PM_SOCIAL.defaults).includes(entry.platform)) throw new Error('Некорректная заявка');
  if (!['username', 'id'].includes(entry.type) || !Array.isArray(entry.identifiers) || entry.identifiers.length < 1 || entry.identifiers.length > 2 ||
      new Set(entry.identifiers).size !== entry.identifiers.length || entry.identifiers.some(v => !PM_SOCIAL.valid(entry.platform, entry.type, v))) throw new Error('Некорректная выборка');
  if (!Number.isInteger(Number(entry.column)) || Number(entry.column) < 0 || Number(entry.column) > 1000 ||
      !Number.isInteger(Number(entry.pageRows)) || Number(entry.pageRows) < entry.identifiers.length) throw new Error('Некорректный столбец или размер страницы');
  const text = v => String(v ?? '').slice(0, 2000);
  return { bidId: entry.bidId, status: text(entry.status), category: text(entry.category), subcategory: text(entry.subcategory), platform: entry.platform,
    column: Number(entry.column), type: entry.type, pageRows: Number(entry.pageRows),
    properties: (entry.properties || []).slice(0, 100).map(p => ({ label: text(p.label), value: text(p.value) })),
    jobs: entry.identifiers.map(identifier => ({ query: { platform: entry.platform, identifier_type: entry.type, identifier }, key: crypto.randomUUID() })) };
}
async function scSource(pack, command, entry, message) {
  let tab;
  try { tab = await chrome.tabs.get(pack.tabId); } catch (_) { throw new Error('Исходная вкладка закрыта. Восстановите связь'); }
  if (!tab.url || new URL(tab.url).origin !== pack.origin) throw new Error('Исходная вкладка сменила сайт. Восстановите связь');
  const result = await chrome.tabs.sendMessage(pack.tabId, { action: 'sc-source', command, packageId: pack.id,
    origin: pack.origin, entries: pack.entries.map(e => ({ bidId: e.bidId, status: e.status })), bidId: entry?.bidId, status: entry?.status, message });
  if (!result?.ok) throw new Error(result?.error || 'Нет связи со списком заявок');
  return result;
}
async function scHandle(msg, sender) {
  if (msg.action === 'sc-public') {
    const c = await scConfig();
    return { mapping: c.mapping, interval: c.interval, catalog: await PM_DB.get('catalog') || [] };
  }
  if (['sc-draft-get', 'sc-draft-save', 'sc-draft-delete'].includes(msg.action)) {
    if (!sender.tab || sender.frameId !== 0 || !/^https?:/.test(sender.url || '')) throw new Error('Нужна исходная страница');
    const key = 'draft:' + sender.tab.id + ':' + new URL(sender.url).origin;
    const binding = await scBinding(await scConfig());
    if (msg.action === 'sc-draft-get') {
      const draft = await PM_DB.get(key);
      return { draft: draft?.binding === binding ? draft : null };
    }
    if (msg.action === 'sc-draft-delete') { await PM_DB.delete(key); return {}; }
    if (!Array.isArray(msg.items) || !msg.items.length || msg.items.length > 10) throw new Error('Неверный черновик');
    const items = msg.items.map(item => {
      if (!/^\d+$/.test(item.bidId) || !Object.values(PM_SOCIAL.defaults).includes(item.platform)) throw new Error('Неверная заявка');
      const selected = item.selection ? scCleanEntry({ ...item, ...item.selection }) : null;
      const text = value => String(value ?? '').slice(0, 2000);
      return { bidId: item.bidId, status: text(item.status), platform: item.platform, category: text(item.category), subcategory: text(item.subcategory),
        properties: (item.properties || []).slice(0, 100).map(p => ({ label: text(p.label), value: text(p.value) })), skipped: !!item.skipped,
        draftColumn: Math.max(0, Math.min(1000, Number(item.draftColumn) || 0)), draftType: ['id', 'username'].includes(item.draftType) ? item.draftType : undefined,
        selection: selected ? { column: selected.column, type: selected.type, pageRows: selected.pageRows, identifiers: selected.jobs.map(j => j.query.identifier) } : null };
    });
    if (!/^[a-f0-9-]{36}$/.test(msg.packageId)) throw new Error('Неверный ID черновика');
    await PM_DB.set(key, { binding, items, packageId: msg.packageId, index: Math.max(0, Math.min(items.length - 1, Number(msg.index) || 0)) });
    return {};
  }
  if (msg.action === 'sc-config-get') {
    if (!scPage(sender, 'options.html')) throw new Error('Доступ запрещён');
    const c = await scConfig(); return { url: c.url, interval: c.interval, mapping: c.mapping, hasKey: !!c.key };
  }
  if (msg.action === 'sc-config-save') {
    if (!scPage(sender, 'options.html')) throw new Error('Доступ запрещён');
    const old = await scConfig(), url = new URL(msg.config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Укажите HTTP(S) адрес без пароля, query и фрагмента');
    url.pathname = url.pathname.replace(/\/*$/, '/');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Для API с ключом требуется HTTPS');
    const mapping = msg.config.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.values(mapping).some(v => !Object.values(PM_SOCIAL.defaults).includes(v))) throw new Error('Неверное сопоставление категорий');
    const c = { url: url.href, key: msg.config.clearKey ? '' : msg.config.key || (old.url === url.href ? old.key : ''),
      interval: Math.max(800, Math.min(60000, Number(msg.config.interval) || 800)), mapping };
    await PM_DB.set('config', c);
    if (await scBinding(old) !== await scBinding(c)) await PM_DB.delete('catalog');
    return {};
  }
  if (msg.action === 'sc-test') {
    if (!scPage(sender, 'options.html')) throw new Error('Доступ запрещён');
    const result = await scApi('platforms');
    if (!Array.isArray(result.platforms)) throw new Error('Неверный ответ каталога API');
    await PM_DB.set('catalog', result.platforms);
    return { catalog: result.platforms };
  }
  if (msg.action === 'sc-create') {
    if (!sender.tab || sender.frameId !== 0 || !sender.url || !/^https?:/.test(sender.url)) throw new Error('Нужна исходная страница списка');
    if (!Array.isArray(msg.entries) || !msg.entries.length || msg.entries.length > 10) throw new Error('Неверный размер пакета');
    const c = await scConfig();
    if (!/^[a-f0-9-]{36}$/.test(msg.packageId)) throw new Error('Неверный ID пакета');
    const existing = await PM_DB.get('package:' + msg.packageId);
    if (existing) {
      if (existing.tabId !== sender.tab.id || existing.origin !== new URL(sender.url).origin || existing.binding !== await scBinding(c)) throw new Error('Пакет относится к другой странице или магазину');
      await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') + '?id=' + existing.id, index: sender.tab.index + 1, openerTabId: sender.tab.id });
      return { id: existing.id };
    }
    const pack = { id: msg.packageId, created: Date.now(), origin: new URL(sender.url).origin,
      tabId: sender.tab.id, binding: await scBinding(c), entries: msg.entries.map(scCleanEntry) };
    if (new Set(pack.entries.map(e => e.bidId)).size !== pack.entries.length) throw new Error('Повтор заявки');
    const catalog = await PM_DB.get('catalog') || [];
    if (pack.entries.some(e => !PM_SOCIAL.types(catalog, e.platform).includes(e.type))) throw new Error('Способ поиска отключён в каталоге');
    await scSave(pack);
    const ids = await PM_DB.get('packages') || [];
    await PM_DB.set('packages', [...ids, pack.id]);
    await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') + '?id=' + pack.id,
      index: sender.tab.index + 1, openerTabId: sender.tab.id });
    return { id: pack.id };
  }
  if (!scTrusted(sender)) throw new Error('Доступ запрещён');
  if (msg.action === 'sc-list') {
    const packs = await Promise.all((await PM_DB.get('packages') || []).map(id => PM_DB.get('package:' + id)));
    return { packages: packs.filter(Boolean).map(p => ({ id: p.id, created: p.created, count: p.entries.length })) };
  }
  const pack = await scPackage(msg.id);
  if (msg.action === 'sc-get') return { package: pack, sameStore: pack.binding === await scBinding(await scConfig()) };
  if (msg.action === 'sc-delete') {
    await PM_DB.delete('package:' + pack.id);
    await PM_DB.set('packages', (await PM_DB.get('packages') || []).filter(id => id !== pack.id));
    return {};
  }
  if (msg.action === 'sc-reconnect') {
    const tabId = Number(msg.tabId);
    if (!Number.isInteger(tabId)) throw new Error('Укажите ID открытой вкладки админки');
    const candidate = { ...pack, tabId };
    await scSource(candidate, 'bind');
    pack.tabId = tabId; await scSave(pack); return {};
  }
  if (msg.action === 'sc-tabs') {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.filter(tab => { try { return new URL(tab.url).origin === pack.origin; } catch (_) { return false; } })
      .map(tab => ({ id: tab.id, title: tab.title || 'Админка' })) };
  }
  if (msg.action === 'sc-sync') {
    const result = await scSource(pack, 'snapshot');
    for (const entry of pack.entries) {
      const current = result.entries.find(e => e.bidId === entry.bidId);
      entry.sourceStatus = current?.status ?? null;
    }
    await scSave(pack); return {};
  }
  const entry = pack.entries.find(e => e.bidId === msg.bidId);
  if (!entry) throw new Error('Заявка не входит в пакет');
  if (msg.action === 'sc-decision') {
    if (!['accept', 'decline'].includes(msg.decision)) throw new Error('Неверное решение');
    if (msg.decision === 'accept' && !['2', '6', '7'].includes(entry.status)) throw new Error('Этот статус нельзя принять');
    if (msg.decision === 'decline' && (entry.status === '4' || !String(msg.message || '').trim())) throw new Error('Укажите причину или проверьте статус');
    await scSource(pack, 'bind');
    const result = await scSource(pack, msg.decision, entry, msg.message);
    entry.status = entry.sourceStatus = result.status;
    entry.decision = msg.decision; await scSave(pack); return {};
  }
  if (!['sc-submit', 'sc-refresh'].includes(msg.action)) throw new Error('Неизвестная команда');
  if (!scPage(sender, 'review.html')) throw new Error('Откройте страницу результатов');
  if (pack.binding !== await scBinding(await scConfig())) throw new Error('URL или ключ магазина изменились. Для этого пакета API заблокирован');
  const owner = pack.id + ':' + msg.client;
  scAssertLive(owner);
  const job = entry.jobs[msg.job];
  if (!job) throw new Error('Проверка не найдена');
  if (msg.action === 'sc-submit' && job.check?.id) return {};
  if (msg.action === 'sc-submit' && job.rejected) throw new Error('Запрос отклонён API. Автоматический новый платный запрос запрещён');
  if (msg.action === 'sc-refresh' && !job.check?.id) return {};
  // Keys and exact query already durably stored at package creation, before any POST.
  job.error = null; job.attempted = true; await scSave(pack);
  try {
    const check = msg.action === 'sc-submit'
      ? await scApi('checks', { method: 'POST', query: job.query, key: job.key, owner })
      : await scApi('checks/' + encodeURIComponent(job.check.id), { owner });
    if (typeof check.id !== 'string' || !Object.hasOwn(PM_SOCIAL.statuses, check.status) ||
        !check.query || check.query.platform !== job.query.platform || check.query.identifier_type !== job.query.identifier_type ||
        PM_SOCIAL.normalize(job.query.identifier_type, check.query.identifier || '') !== PM_SOCIAL.normalize(job.query.identifier_type, job.query.identifier) ||
        (job.check?.id && job.check.id !== check.id)) throw new Error('Некорректный ответ проверки; повторите с прежним ключом');
    job.check = check;
  } catch (e) {
    job.error = e.message;
    // Auth/balance/limit are safe to resume manually. No fresh keys on any retry.
    if ([400, 409].includes(e.httpStatus)) job.rejected = true;
    await scSave(pack); throw e;
  }
  await scSave(pack); return {};
}
chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith('pm-review:') || !scPage(port.sender, 'review.html')) return;
  const id = port.name.slice('pm-review:'.length);
  if (!scLive.has(id)) scLive.set(id, new Set());
  scLive.get(id).add(port);
  port.onDisconnect.addListener(() => { scLive.get(id)?.delete(port); });
});
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg?.action?.startsWith('sc-') || msg.action === 'sc-source') return;
  const task = scSerial.then(() => scHandle(msg, sender));
  scSerial = task.catch(() => {});
  task.then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});
