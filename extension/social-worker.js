'use strict';

const scDefaultConfig = { url: 'https://216.57.104.188/', key: '', interval: 800, mapping: PM_SOCIAL.defaults };
let scSerial = Promise.resolve();
let scLimitSerial = Promise.resolve();
let scStartSerial = Promise.resolve();
let scNextStart = 0;
const scBootTime = Date.now();
const scInFlight = new Map();
// Local, secret-free progress for the settings connection test. Reading this
// must not wait behind the very queue whose state we are trying to diagnose.
let scConnectionTest = null;
function scConnectionProgress(stage, waitUntil = 0) {
  scConnectionTest = { stage, waitUntil, startedAt: scConnectionTest?.startedAt || Date.now(), updatedAt: Date.now() };
}
function scExclusive(fn) {
  const task = scSerial.then(fn);
  scSerial = task.catch(() => {});
  return task;
}
const scLive = new Map();
const scSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scPage = (sender, page) => sender.url?.split('?')[0] === chrome.runtime.getURL(page);
const scTrusted = sender => scPage(sender, 'options.html') || scPage(sender, 'review.html');
async function scConfig() {
  const saved = await PM_DB.get('config');
  return { ...scDefaultConfig, ...saved, mapping: { ...PM_SOCIAL.defaults, ...saved?.mapping } };
}
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
function scBackoff(retry = 0, reason = 'temporary') {
  const task = scLimitSerial.then(async () => {
    const limit = await PM_DB.get('api-limit') || { next: 0, failures: 0 };
    limit.failures++;
    limit.next = Math.max(limit.next, Date.now() + Math.max(retry, PM_SOCIAL.retryDelay));
    limit.reason = reason;
    await PM_DB.set('api-limit', limit);
  });
  scLimitSerial = task.catch(() => {});
  return task;
}
function scRateStarts(rate) {
  return (Array.isArray(rate?.starts) ? rate.starts : [])
    .filter(at => Number.isFinite(at) && at > Date.now() - PM_SOCIAL.apiMinuteWindow);
}
function scRepairRateClock(rate) {
  if (!rate) return rate;
  const starts = (Array.isArray(rate.starts) ? rate.starts : []).filter(Number.isFinite);
  // `next` is written only as dispatch time + apiInterval, never Retry-After.
  // Future dispatches therefore mean that the wall clock has moved backwards.
  const last = Math.max(Number.isFinite(rate.next) ? rate.next - PM_SOCIAL.apiInterval : 0, ...starts);
  const now = Date.now();
  if (last <= now) return rate;
  const shift = now - last;
  // Rebase, don't clear the minute history: keep the same relative ages and
  // conservatively count the latest previous dispatch as happening right now.
  return { ...rate, next: now + PM_SOCIAL.apiInterval, starts: starts.map(at => at + shift) };
}
function scRateNext(rate) {
  const starts = scRateStarts(rate);
  return Math.max(rate?.next || 0, scNextStart,
    starts.length >= PM_SOCIAL.apiMinuteLimit ? starts[starts.length - PM_SOCIAL.apiMinuteLimit] + PM_SOCIAL.apiMinuteWindow : 0,
    rate ? scBootTime + PM_SOCIAL.apiInterval : 0);
}
function scRecovered() {
  const task = scLimitSerial.then(async () => {
    const limit = await PM_DB.get('api-limit');
    // A successful in-flight request must not erase another response's cooldown.
    if (limit && limit.next <= Date.now()) await PM_DB.set('api-limit', { ...limit, failures: 0 });
  });
  scLimitSerial = task.catch(() => {});
  return task;
}
async function scApi(path, { method = 'GET', query, key, owner, binding, preflight, diagnostic, onStart, progress } = {}) {
  // One FIFO admission queue for POST, GET, catalog calls and retries across tabs.
  // Release the slot after starting fetch(), never after receiving its response.
  progress?.('queue');
  const start = scStartSerial.then(async () => {
    let config;
    for (;;) {
      await scLimitSerial;
      const limit = await PM_DB.get('api-limit'), savedRate = await PM_DB.get('api-rate');
      const rate = scRepairRateClock(savedRate);
      if (rate !== savedRate) await PM_DB.set('api-rate', rate);
      const next = Math.max(limit?.next || 0, scRateNext(rate));
      if (next > Date.now()) {
        progress?.(limit?.next > Date.now() ? 'cooldown' : 'rate', next);
        await scSleep(next - Date.now());
      }
      scAssertLive(owner);
      if (next > Date.now()) continue;
      await scLimitSerial;
      if ((await PM_DB.get('api-limit'))?.next > Date.now()) continue;
      scAssertLive(owner);
      progress?.('config');
      config = await scConfig();
      if (binding && binding !== await scBinding(config)) throw new Error('URL или ключ магазина изменились. Для этого пакета API заблокирован');
      if (!config.key) throw new Error('Укажите API-ключ в настройках');
      progress?.('permission');
      if (!await chrome.permissions.contains({ origins: [new URL(config.url).origin + '/*'] })) throw new Error('Нет разрешения на доступ к серверу. Сохраните настройки Social Check');
      await preflight?.();
      await scLimitSerial;
      if ((await PM_DB.get('api-limit'))?.next > Date.now()) continue;
      break;
    }
    scAssertLive(owner);
    await onStart?.();
    // Reserve durably before dispatch, including failed/uncertain requests. No secrets.
    const starts = scRateStarts(await PM_DB.get('api-rate'));
    starts.push(Date.now());
    await PM_DB.set('api-rate', { next: Date.now() + PM_SOCIAL.apiInterval, starts });
    scAssertLive(owner);
    let trace;
    if (diagnostic) {
      PM_DIAG.addSecrets([config.key]);
      trace = PM_DIAG.start({ ...diagnostic, kind: 'social', method, endpoint: new URL('api/v1/' + path, config.url).href,
        queryKey: PM_DIAG.queryKey(diagnostic.query) });
      diagnostic.traceId = trace;
    }
    let outcome;
    try {
      progress?.('response');
      outcome = Promise.resolve(fetch(new URL('api/v1/' + path, config.url).href, {
        method, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + config.key, ...(query ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
        ...(query ? { body: JSON.stringify(query) } : {}), signal: AbortSignal.timeout(30000),
      })).then(response => ({ response }), error => ({ error }));
    } catch (error) { outcome = Promise.resolve({ error }); }
    scNextStart = Date.now() + PM_SOCIAL.apiInterval;
    // Use actual dispatch time for the rolling minute, not the preflight start.
    starts[starts.length - 1] = Date.now();
    await PM_DB.set('api-rate', { next: scNextStart, starts });
    return { outcome, trace };
  });
  scStartSerial = start.then(() => {}, () => {});
  const { outcome, trace } = await start;
  let response;
  try {
    const result = await outcome;
    if (result.error) throw result.error;
    response = result.response;
  } catch (err) {
    PM_DIAG.error(trace, err);
    await scBackoff();
    throw Object.assign(new Error('Нет ответа от Social Check: сеть, TLS, CORS или таймаут; повтор использует прежний ключ'), {
      retryable: true, errorKind: err?.name === 'TimeoutError' ? 'timeout' : 'network' });
  }
  // Publish cooldown as soon as headers arrive, before reading diagnostic bodies.
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    const header = response.headers.get('Retry-After');
    const retry = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now()) || 0;
    await scBackoff(retry || (response.status === 429 ? PM_SOCIAL.apiMinuteWindow : 0),
      response.status === 429 ? 'rate_limit' : 'temporary');
  }
  const captured = diagnostic ? await PM_DIAG.capture(response, trace) : null;
  if (!response.ok) {
    const messages = { 400: 'API отклонил параметры', 401: 'Неверный API-ключ', 402: 'Недостаточно средств',
      403: 'Доступ запрещён', 409: 'Конфликт ключа идемпотентности', 429: 'Лимит API: повторите позднее', 503: 'Биллинг временно недоступен' };
    const error = new Error(messages[response.status] || `API: HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
    PM_DIAG.error(trace, error);
    throw error;
  }
  await scRecovered();
  let json;
  progress?.('json');
  try { json = captured ? captured.json() : await response.json(); } catch (err) {
    PM_DIAG.error(trace, err);
    await scBackoff();
    throw Object.assign(new Error('API вернул некорректный JSON; повтор использует прежний ключ'), {
      retryable: true, errorKind: err?.name === 'TimeoutError' ? 'timeout' : 'invalid_response', httpStatus: response.status });
  }
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
  if (msg.action === 'sc-auto-create') return scAutoCreate(msg, sender);
  if (msg.action === 'sc-public') {
    const c = await scConfig();
    return { mapping: c.mapping, interval: c.interval, catalog: await PM_DB.get('catalog') || [],
      aiConcurrency: typeof aiConfig === 'function' ? (await aiConfig()).concurrency : 3 };
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
    scConnectionProgress('config');
    const binding = await scBinding(await scConfig());
    // Network admission may need scExclusive for another job's onStart progress.
    // Never hold the state lock while waiting in the shared HTTP queue.
    return async () => {
      const result = await scApi('platforms', { binding, progress: scConnectionProgress });
      if (!Array.isArray(result.platforms)) throw new Error('Неверный ответ каталога API');
      return scExclusive(async () => {
        if (binding !== await scBinding(await scConfig())) throw new Error('Настройки Social Check изменились во время проверки связи');
        await PM_DB.set('catalog', result.platforms);
        return { catalog: result.platforms };
      });
    };
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
  if (msg.action === 'sc-get') {
    let changed = false;
    for (const entry of pack.entries) for (let i = 0; i < entry.jobs.length; i++) {
      const job = entry.jobs[i];
      if (!['queued', 'sending', 'retry_wait'].includes(job.requestState) || scInFlight.has(JSON.stringify([pack.id, entry.bidId, i]))) continue;
      if (job.attemptCount >= PM_SOCIAL.retryLimit + 1) {
        job.requestState = 'failed'; job.retryable = true;
        job.error = 'Лимит попыток исчерпан; ответ последней попытки не сохранился. Можно продолжить вручную с тем же ключом';
      } else if (job.requestState === 'sending') {
        job.requestState = 'retry_wait';
        job.retryAt = Date.now() + PM_SOCIAL.retryDelay;
        job.error = 'Фоновая обработка прервалась; восстанавливаю ответ с прежним ключом';
      } else continue;
      changed = true;
    }
    if (changed) await scSave(pack);
    const limit = await PM_DB.get('api-limit'), rate = await PM_DB.get('api-rate');
    return { package: pack, sameStore: pack.binding === await scBinding(await scConfig()),
      apiQueue: { resumeAt: Math.max(limit?.next || 0, scRateNext(scRepairRateClock(rate))),
        reason: limit?.next > Date.now() ? limit.reason || 'temporary' : 'rate',
        active: scInFlight.size } };
  }
  if (msg.action === 'sc-diagnostics') {
    if (!scPage(sender, 'review.html')) throw new Error('Откройте страницу результатов');
    const target = pack.entries.find(e => e.bidId === msg.bidId);
    if (!target) throw new Error('Заявка не входит в пакет');
    if (msg.rowId !== undefined && (!Number.isInteger(msg.rowId) || msg.rowId < 1 || msg.job !== undefined)) throw new Error('Некорректная строка');
    let query;
    if (msg.job !== undefined) {
      if (!Number.isInteger(msg.job) || !target.jobs[msg.job]) throw new Error('Аккаунт не найден');
      query = target.jobs[msg.job].query;
    }
    PM_DIAG.addSecrets([(await scConfig()).key, typeof aiConfig === 'function' ? (await aiConfig()).key : '']);
    return { diagnostics: PM_DIAG.get(pack.id, target.bidId, query, msg.rowId) };
  }
  if (msg.action === 'sc-delete') {
    PM_DIAG.clear(pack.id);
    if (typeof aiRuns !== 'undefined') { aiRuns.get(pack.id)?.controller.abort(); aiRuns.delete(pack.id); }
    await PM_DB.delete('package:' + pack.id);
    await PM_DB.set('packages', (await PM_DB.get('packages') || []).filter(id => id !== pack.id));
    return {};
  }
  if (msg.action === 'sc-auto-retry') {
    if (!pack.auto || !scPage(sender, 'review.html')) throw new Error('Откройте автоматический пакет');
    // Release the worker's state lock before the content script creates the new run.
    return () => scSource(pack, 'prepare-auto');
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
  const slot = JSON.stringify([pack.id, entry.bidId, msg.job]);
  if (scInFlight.has(slot)) { const running = scInFlight.get(slot); return () => running; }
  if (msg.action === 'sc-submit' && job.check?.id) return {};
  if (msg.action === 'sc-submit' && job.rejected) throw new Error('Запрос отклонён API. Автоматический новый платный запрос запрещён');
  if (msg.action === 'sc-refresh' && !job.check?.id) return {};
  if (msg.manual === false && PM_SOCIAL.autoAction(job) !== msg.action) return {};
  const used = msg.manual === false ? PM_SOCIAL.resumeAttempts(job, msg.action) : 0;
  const retryAt = used ? job.retryAt || Date.now() + PM_SOCIAL.retryDelay : 0;
  // Keys and exact query already durably stored at package creation, before any POST.
  job.error = null; job.retryCount = Math.max(0, used - 1); job.attempted = true;
  job.requestAction = msg.action; job.requestState = used ? 'retry_wait' : 'queued';
  job.attemptCount = used; job.retryAt = retryAt; job.errorKind = null; job.lastHttpStatus = null;
  await scSave(pack);
  const running = scRunCheck(msg, pack, entry, job, owner, used);
  scInFlight.set(slot, running);
  running.then(() => scInFlight.delete(slot), () => scInFlight.delete(slot));
  return () => running;
}
async function scJobProgress(msg, pack, job) {
  await scExclusive(async () => {
    const latest = await scPackage(pack.id);
    const target = latest.entries.find(e => e.bidId === msg.bidId)?.jobs[msg.job];
    if (!target || target.key !== job.key) throw new Error('Проверка в пакете изменилась');
    for (const field of ['error', 'retryCount', 'requestAction', 'requestState', 'attemptCount',
      'retryAt', 'lastAttemptAt', 'errorKind', 'lastHttpStatus', 'retryable', 'nextPollAt']) target[field] = job[field] ?? null;
    if (job.check) target.check = job.check;
    if (job.rejected) target.rejected = true;
    await scSave(latest);
  });
}
async function scRunCheck(msg, pack, entry, job, owner, used = 0) {
  let error;
  for (let attempt = used; attempt <= PM_SOCIAL.retryLimit; attempt++) {
    let diagnostic;
    try {
      if (job.retryAt > Date.now()) await scSleep(job.retryAt - Date.now());
      scAssertLive(owner);
      job.requestState = 'queued'; job.retryAt = 0;
      await scJobProgress(msg, pack, job);
      diagnostic = { packId: pack.id, bidId: entry.bidId, query: job.query, attempt: attempt + 1 };
      const request = { owner, binding: pack.binding, diagnostic, onStart: async () => {
        job.requestState = 'sending'; job.attemptCount = attempt + 1; job.retryCount = attempt;
        job.lastAttemptAt = Date.now();
        await scJobProgress(msg, pack, job);
      }, preflight: async () => {
        const latest = await scPackage(pack.id);
        if (latest.entries.find(e => e.bidId === entry.bidId)?.jobs[msg.job]?.key !== job.key) throw new Error('Проверка в пакете изменилась');
        if (latest.auto && msg.action === 'sc-submit') {
          if (latest.aiPaused && !msg.manual) throw new Error('Подготовка приостановлена. Повторите извлечение или продолжите вручную');
          const snapshot = await scSource(latest, 'snapshot');
          if (snapshot.entries.find(e => e.bidId === entry.bidId)?.status !== entry.status) throw new Error('Строка или статус изменились. Сверьте статусы перед проверкой');
        }
      } };
      const check = msg.action === 'sc-submit'
        ? await scApi('checks', { ...request, method: 'POST', query: job.query, key: job.key })
        : await scApi('checks/' + encodeURIComponent(job.check.id), request);
      if (typeof check?.id !== 'string' || !Object.hasOwn(PM_SOCIAL.statuses, check.status) ||
          !check.query || check.query.platform !== job.query.platform || check.query.identifier_type !== job.query.identifier_type ||
          typeof check.query.identifier !== 'string' ||
          PM_SOCIAL.normalize(job.query.identifier_type, check.query.identifier) !== PM_SOCIAL.normalize(job.query.identifier_type, job.query.identifier) ||
           (job.check?.id && job.check.id !== check.id)) throw Object.assign(new Error('Некорректный ответ проверки; повтор использует прежний ключ'), { retryable: true, errorKind: 'invalid_response' });
      job.check = check; job.error = null; job.requestState = 'confirmed'; job.retryable = false;
      job.nextPollAt = ['pending', 'running'].includes(check.status) ? Date.now() + PM_SOCIAL.pollInterval : 0;
      job.errorKind = null; job.lastHttpStatus = null; job.retryAt = 0; error = null; break;
    } catch (e) {
      PM_DIAG.error(diagnostic?.traceId, e);
      job.error = e.message;
      job.retryable = !!e.retryable; job.lastHttpStatus = e.httpStatus || null;
      job.errorKind = e.errorKind || (e.httpStatus === 408 ? 'timeout' : e.httpStatus >= 500 ? 'server' : e.httpStatus === 429 ? 'rate_limit' :
        [401, 403].includes(e.httpStatus) ? 'auth' : e.httpStatus === 402 ? 'balance' : e.httpStatus ? 'api' : 'local');
      if ([400, 409].includes(e.httpStatus)) job.rejected = true;
      error = e;
      job.requestState = !e.retryable && !e.httpStatus ? 'paused' : 'failed';
      if (!e.retryable || attempt === PM_SOCIAL.retryLimit) break;
      try {
        scAssertLive(owner);
        job.requestState = 'retry_wait';
        job.retryAt = Math.max(Date.now() + PM_SOCIAL.retryDelay, (await PM_DB.get('api-limit'))?.next || 0);
        await scJobProgress(msg, pack, job);
        await scSleep(Math.max(0, job.retryAt - Date.now()));
        scAssertLive(owner);
      } catch (cancel) {
        job.error = cancel.message; job.errorKind = 'local'; job.requestState = 'paused'; job.retryable = false;
        error = cancel; break;
      }
    }
  }
  await scJobProgress(msg, pack, job);
  if (error) throw error;
  return {};
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
  if (msg.action === 'sc-test-status') {
    if (!scPage(sender, 'options.html')) respond({ ok: false, error: 'Доступ запрещён' });
    else respond({ ok: true, test: scConnectionTest });
    return;
  }
  const connectionTest = msg.action === 'sc-test' && scPage(sender, 'options.html');
  if (connectionTest) {
    scConnectionTest = null;
    scConnectionProgress('state');
  }
  const task = scExclusive(() => scHandle(msg, sender)).then(result => typeof result === 'function' ? result() : result);
  task.then(result => {
    if (connectionTest) scConnectionProgress('done');
    respond({ ok: true, ...result });
  }, error => {
    const stage = connectionTest ? scConnectionTest?.stage : null;
    if (connectionTest) scConnectionProgress('failed');
    respond({ ok: false, error: error.message, ...(connectionTest ? { stage } : {}) });
  });
  return true;
});
