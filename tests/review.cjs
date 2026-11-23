const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const file = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function review(jobs, failSubmit = false, extra = {}) {
  const pack = { id: 'synthetic', auto: !!extra.auto, tabId: 7, entries: [{ bidId: '42', status: '2', category: 'Instagram', subcategory: 'Synthetic',
    column: 0, type: 'username', pageRows: 20, properties: [{ label: 'Подписчики', value: '100' }, { label: 'Непроверяемое свойство', value: 'Synthetic' }], jobs, ...extra.entry }] };
  const dom = new JSDOM(file('review.html'), { url: 'https://extension.example.test/review.html?id=synthetic', runScripts: 'dangerously' });
  const w = dom.window, messages = [];
  const intervals = [];
  w.setInterval = fn => { intervals.push(fn); return 1; };
  w.chrome = { runtime: { connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }), sendMessage: async msg => {
    messages.push(msg);
    if (msg.action === 'sc-list') return { ok: true, packages: [] };
    if (msg.action === 'sc-get') return { ok: true, package: structuredClone(pack), sameStore: true };
    if (msg.action === 'sc-diagnostics') return { ok: true, diagnostics: extra.diagnostics || { available: false, rowChoices: [], rows: [], ai: [], social: [] } };
    if (msg.action === 'ai-manual-preview') return { ok: true, rows: [{ index: 1, value: 'mail@example.test|manual_profile|SYNTHETIC_PASSWORD' },
      { index: 2, value: 'mail@example.test||SYNTHETIC_PASSWORD' }], digest: 'synthetic-digest', runId: 'synthetic-run', types: ['username'], platform: 'instagram' };
    if (msg.action === 'ai-manual-apply') return { ok: true, added: 1, remaining: 1 };
    if (msg.action === 'sc-submit' && failSubmit) return { ok: false, error: 'Synthetic pause' };
    return { ok: true };
  } }, storage: { local: { get: (_, cb) => cb({}) }, onChanged: { addListener() {} } } };
  for (const name of ['rejection-reasons.js', 'social-common.js', 'content.js', 'review-diagnostics.js', 'review-manual.js', 'review.js']) {
    const script = w.document.createElement('script'); script.textContent = file(name); w.document.head.append(script);
  }
  await settle(); return { w, dom, messages, pack, intervals };
}
const job = status => ({ query: { platform: 'instagram', identifier_type: 'username', identifier: 'test_profile' }, key: 'synthetic-key',
  check: { id: 'synthetic-check', status, query: {}, result: { data: { followers: 0, bio: null } } } });
test('account table keeps login in each row and omits avatar, link, name and bio', async () => {
  const profile = job('found');
  Object.assign(profile.check.result.data, { avatar_url: 'https://example.test/avatar', profile_url: 'https://example.test/profile',
    display_name: 'Synthetic name', username: 'synthetic_name', external_id: '123', registration_date: '2020-05-17' });
  const s = await review([profile]);
  try {
    const table = s.w.document.querySelector('.accounts-table');
    assert.deepEqual([...table.querySelectorAll('th')].map(n => n.textContent),
      ['Логин / ID', 'Состояние', 'ID', 'Регистрация', 'Публикации', 'Друзья', 'Подписчики', 'Подписки', 'Подробности / ошибка']);
    const cells = [...table.querySelector('tbody tr').children].map(n => n.textContent);
    assert.equal(cells[0], 'test_profile'); assert.equal(cells[2], '123');
    assert.equal(cells[3], '2020-05-17');
  } finally { s.dom.window.close(); }
});
test('Reddit results show separate post/comment karma, preserve zero/negatives and never infer missing values', async () => {
  const jobs = [0, -12, 3456, null].map((karma, i) => {
    const profile = job('found');
    profile.query.platform = 'reddit'; profile.query.identifier = 'synthetic_reddit_' + i;
    profile.check.result.data.post_karma = karma;
    profile.check.result.data.comment_karma = [12, 0, -34, null][i];
    profile.check.result.data.karma = 9999;
    return profile;
  });
  const s = await review(jobs, false, { entry: { platform: 'reddit', category: 'Reddit' } });
  try {
    const table = s.w.document.querySelector('.accounts-table');
    const headers = [...table.querySelectorAll('th')].map(node => node.textContent);
    const index = headers.indexOf('Карма постов');
    assert.ok(index > 0);
    assert.deepEqual([...table.querySelectorAll('tbody tr')].map(tr => tr.children[index].textContent),
      ['0', '-12', '3456', 'Нет данных']);
    const commentIndex = headers.indexOf('Карма комментариев');
    assert.ok(commentIndex > 0);
    assert.deepEqual([...table.querySelectorAll('tbody tr')].map(tr => tr.children[commentIndex].textContent),
      ['12', '0', '-34', 'Нет данных']);
  } finally { s.dom.window.close(); }
  const other = await review([job('found')]);
  try { assert.doesNotMatch(other.w.document.querySelector('thead').textContent, /Карма/); }
  finally { other.dom.window.close(); }
});
test('an unresolved Reddit bid still has both karma columns and correct error row colspan', async () => {
  const s = await review([], false, { entry: { platform: 'reddit', extractionError: 'Synthetic unresolved login' } });
  try {
    const table = s.w.document.querySelector('.accounts-table');
    assert.match(table.querySelector('thead').textContent, /Карма постов/);
    assert.match(table.querySelector('thead').textContent, /Карма комментариев/);
    assert.equal(table.querySelector('tbody td:nth-child(2)').colSpan, table.querySelectorAll('th').length - 1);
  } finally { s.dom.window.close(); }
});
test('automatic review submits ready logins but does not retry an unclassified legacy error blindly', async () => {
  const j = { query: job('pending').query, key: 'synthetic-key', attempted: true, error: 'Synthetic network error' };
  const s = await review([j], false, { auto: true, entry: { title: 'Synthetic title', description: 'Synthetic multiline\ndescription' } });
  try {
    assert.match(s.w.document.querySelector('.description').textContent, /Synthetic multiline/);
    assert.match(s.w.document.querySelector('.accounts-table tbody tr').textContent, /test_profile/);
    assert.equal(s.messages.some(m => m.action === 'sc-submit'), false);
    s.pack.entries[0].jobs.push({ query: { ...j.query, identifier: 'second_profile' }, key: 'second-key' });
    await s.intervals[0](); await settle();
    const submits = s.messages.filter(m => m.action === 'sc-submit');
    assert.equal(submits.length, 1);
    assert.equal(submits[0].job, 1);
    assert.equal(submits[0].manual, false);
  } finally { s.dom.window.close(); }
});
test('automatic review restores a known uncertain POST with a remaining budget but leaves exhausted/auth errors stopped', async () => {
  const uncertain = { query: job('pending').query, key: 'stable-key', attempted: true, retryCount: 1,
    error: 'Сетевой сбой. Результат отправки неизвестен; повтор использует прежний ключ' };
  const s = await review([uncertain, { ...uncertain, key: 'exhausted', retryCount: 10 },
    { ...uncertain, key: 'auth', error: 'Неверный API-ключ' }], false, { auto: true });
  try {
    const submits = s.messages.filter(m => m.action === 'sc-submit');
    assert.equal(submits.length, 1); assert.equal(submits[0].job, 0); assert.equal(submits[0].manual, false);
  } finally { s.dom.window.close(); }
});
test('waiting and retrying rows show the actual stage, attempt, HTTP code and error cause', async () => {
  const rows = [
    { query: job('pending').query, key: 'sending', attempted: true, requestAction: 'sc-submit', requestState: 'sending', attemptCount: 1 },
    { query: job('pending').query, key: 'retry', attempted: true, requestAction: 'sc-submit', requestState: 'retry_wait',
      attemptCount: 2, retryAt: Date.now() + 2000, lastHttpStatus: 503, errorKind: 'server', error: 'Synthetic temporary server error' },
    { query: job('pending').query, key: 'failed', attempted: true, requestAction: 'sc-submit', requestState: 'failed',
      attemptCount: 11, retryCount: 10, retryable: true, errorKind: 'network', error: 'Synthetic offline' },
  ];
  const s = await review(rows);
  try {
    const rendered = [...s.w.document.querySelectorAll('.accounts-table tbody tr')];
    assert.match(rendered[0].children[1].textContent, /Ожидание ответа на отправку · попытка 1\/11/);
    assert.doesNotMatch(rendered[0].textContent, /Отправка не подтверждена/);
    assert.match(rendered[1].textContent, /Повтор отправки через/);
    assert.match(rendered[1].textContent, /попытка 3\/11/);
    assert.match(rendered[1].textContent, /HTTP 503/);
    assert.match(rendered[1].textContent, /Social Check или его прокси/);
    assert.match(rendered[2].textContent, /попытки исчерпаны/);
    assert.match(rendered[2].textContent, /сторона сбоя не установлена/);
    assert.equal(rendered[2].querySelector('.pm-request-retry').disabled, false);
  } finally { s.dom.window.close(); }
});
test('queued jobs are shown as queued rather than unconfirmed or sending', async () => {
  const s = await review([{ query: job('pending').query, key: 'queued', attempted: true,
    requestAction: 'sc-submit', requestState: 'queued', attemptCount: 0 }]);
  try {
    const row = s.w.document.querySelector('tbody tr');
    assert.match(row.textContent, /В очереди отправки · лимит 5 запросов\/с/);
    assert.doesNotMatch(row.textContent, /Отправка не подтверждена|Ожидание ответа/);
    assert.equal(row.querySelector('.pm-request-retry'), null);
  } finally { s.dom.window.close(); }
});
test('table progress redraws during a slow batch instead of waiting for every request to finish', async () => {
  const j = { query: job('pending').query, key: 'stable-key' };
  const s = await review([j]);
  try {
    Object.defineProperty(s.w.document, 'hidden', { value: false, configurable: true });
    const send = s.w.chrome.runtime.sendMessage; let finish;
    s.w.chrome.runtime.sendMessage = msg => msg.action === 'sc-submit'
      ? new Promise(resolve => { finish = resolve; }) : send(msg);
    s.w.document.getElementById('check').click(); await settle();
    Object.assign(s.pack.entries[0].jobs[0], { attempted: true, requestState: 'retry_wait', requestAction: 'sc-submit',
      attemptCount: 3, retryAt: Date.now() + 2000, errorKind: 'network', error: 'Synthetic transport failure' });
    await s.intervals[0](); await settle();
    assert.match(s.w.document.querySelector('tbody tr').textContent, /Повтор отправки через/);
    assert.match(s.w.document.querySelector('tbody tr').textContent, /попытка 4\/11/);
    assert.equal(s.w.document.getElementById('check').disabled, true);
    finish({ ok: true }); await settle();
  } finally { s.dom.window.close(); }
});
test('accepted results are polled while another POST is slow, with no duplicate dispatch', async () => {
  const s = await review([job('found')], false, { auto: true });
  try {
    s.pack.entries[0].jobs.push({ query: { ...job('pending').query, identifier: 'slow_profile' }, key: 'slow-key' }, job('pending'));
    await s.w.eval('scReviewLoad()');
    const send = s.w.chrome.runtime.sendMessage; let finish, posts = 0;
    s.w.chrome.runtime.sendMessage = msg => {
      if (msg.action === 'sc-submit') { posts++; return new Promise(resolve => { finish = resolve; }); }
      if (msg.action === 'sc-refresh') s.pack.entries[0].jobs[msg.job].check.status = 'found';
      return send(msg);
    };
    s.w.document.getElementById('check').click(); await settle();
    await s.intervals[0](); await settle();
    assert.equal(posts, 1);
    assert.equal(s.messages.filter(m => m.action === 'sc-refresh').length, 1);
    assert.equal(s.w.document.querySelectorAll('tbody tr')[2].children[1].textContent, 'Найден');
    await s.intervals[0](); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-refresh').length, 1);
    finish({ ok: true }); await settle();
  } finally { s.dom.window.close(); }
});
test('an automatic batch started by the interval never holds the progress-refresh lock', async () => {
  const s = await review([job('found')], false, { auto: true });
  try {
    s.pack.entries[0].jobs.push({ query: { ...job('pending').query, identifier: 'slow_profile' }, key: 'slow-key' });
    const send = s.w.chrome.runtime.sendMessage; let finish;
    s.w.chrome.runtime.sendMessage = msg => msg.action === 'sc-submit'
      ? new Promise(resolve => { finish = resolve; }) : send(msg);
    await s.intervals[0](); await settle();
    assert.equal(typeof finish, 'function');
    Object.assign(s.pack.entries[0].jobs[1], { attempted: true, requestState: 'sending',
      requestAction: 'sc-submit', attemptCount: 4 });
    await s.intervals[0](); await settle();
    assert.match(s.w.document.querySelectorAll('tbody tr')[1].textContent, /попытка 4\/11/);
    finish({ ok: true }); await settle();
  } finally { s.dom.window.close(); }
});
test('newly recognized logins enter the queue while another POST and another bid extraction remain unfinished', async () => {
  const s = await review([job('found')], false, { auto: true });
  try {
    s.pack.entries[0].jobs.push({ query: { ...job('pending').query, identifier: 'slow_profile' }, key: 'slow-key' });
    await s.w.eval('scReviewLoad()');
    const send = s.w.chrome.runtime.sendMessage, submitted = []; let finishFirst;
    s.w.chrome.runtime.sendMessage = msg => {
      if (msg.action !== 'sc-submit') return send(msg);
      submitted.push({ bidId: msg.bidId, job: msg.job });
      if (msg.bidId === '42') return new Promise(resolve => { finishFirst = resolve; });
      const entry = s.pack.entries.find(e => e.bidId === msg.bidId);
      entry.jobs[msg.job].check = { ...job('found').check };
      return Promise.resolve({ ok: true });
    };
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(typeof finishFirst, 'function');
    s.pack.entries.push({ ...s.pack.entries[0], bidId: '43', extractionState: 'ready',
      jobs: [{ query: { ...job('pending').query, identifier: 'newly_ready' }, key: 'ready-key' }] },
    { ...s.pack.entries[0], bidId: '44', extractionState: 'pending', jobs: [] });
    await s.intervals[0](); await settle();
    assert.deepEqual(submitted, [{ bidId: '42', job: 1 }, { bidId: '43', job: 0 }]);
    assert.equal(s.pack.entries[2].extractionState, 'pending');
    await s.intervals[0](); await settle();
    assert.equal(submitted.length, 2, 'No duplicate requests while the earlier job is still in flight');
    finishFirst({ ok: true }); await settle();
  } finally { s.dom.window.close(); }
});
test('row retry targets only that job, and accepted checks are refreshed rather than submitted again', async () => {
  for (const accepted of [false, true]) {
    const j = accepted ? job('pending') : { query: job('pending').query, key: 'stable-key', attempted: true };
    Object.assign(j, { requestState: 'failed', requestAction: accepted ? 'sc-refresh' : 'sc-submit',
      retryable: true, attemptCount: 11, error: 'Synthetic exhausted retries' });
    const s = await review([j, job('found')]);
    try {
      s.w.document.querySelector('.pm-request-retry').click(); await settle();
      const requests = s.messages.filter(m => ['sc-submit', 'sc-refresh'].includes(m.action));
      assert.equal(requests.length, 1); assert.equal(requests[0].job, 0);
      assert.equal(requests[0].action, accepted ? 'sc-refresh' : 'sc-submit');
      assert.equal(requests[0].manual, true);
    } finally { s.dom.window.close(); }
  }
});
test('review renders horizontal rows, 0 vs null and unavailable without claiming absence', async () => {
  const s = await review([job('unavailable')]);
  try {
    const table = s.w.document.querySelector('article table');
    assert.equal(table.querySelectorAll('tbody tr').length, 1);
    const cells = [...table.querySelector('tbody tr').children].map(n => n.textContent);
    assert.equal(cells[6], '0'); assert.equal(cells[3], 'Нет данных');
    assert.match(cells[1], /Недоступно \(не означает отсутствие\)/);
    assert.doesNotMatch(s.w.document.querySelector('article').textContent, /Непроверяемое свойство|Исходные свойства поставщика/);
    assert.equal(s.w.document.querySelector('pre'), null);
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-submit').length, 0);
  } finally { s.dom.window.close(); }
});
test('review dispatches the batch concurrently, reports errors and does not issue fresh paid retries', async () => {
  const pendingJob = { query: job('pending').query, key: 'synthetic-key' };
  const s = await review([pendingJob, { ...pendingJob, key: 'synthetic-key-2' }]);
  try {
    const send = s.w.chrome.runtime.sendMessage, pending = [];
    s.w.chrome.runtime.sendMessage = msg => msg.action === 'sc-submit'
      ? new Promise(resolve => pending.push(resolve)) : send(msg);
    s.w.document.getElementById('check').click(); await settle();
    assert.equal(pending.length, 2, 'Send the second job before the first responds');
    pending[0]({ ok: false, error: 'Synthetic pause' }); await settle();
    assert.equal(s.w.document.getElementById('check').disabled, true, 'Wait for already-sent jobs even after one fails');
    pending[1]({ ok: true }); await settle();
    assert.match(s.w.document.getElementById('notice').textContent, /Часть запросов не завершилась/);
    assert.equal(s.w.document.getElementById('check').disabled, false);
  } finally { s.dom.window.close(); }
});
test('each account occupies its own row; supplier properties table is removed', async () => {
  const first = job('found'), second = job('found');
  first.query.identifier = 'synthetic_first'; first.check.result.data.followers = 120;
  second.query.identifier = 'synthetic_second'; second.check.result.data.followers = 5;
  const s = await review([first, second]);
  try {
    const rows = [...s.w.document.querySelectorAll('.accounts-table tbody tr')];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(tr => [tr.children[0].textContent, tr.children[6].textContent]),
      [['synthetic_first', '120'], ['synthetic_second', '5']]);
    const supplierRows = [...s.w.document.querySelectorAll('article > table tr')];
    assert.equal(supplierRows.length, 0);
    assert.equal(s.w.document.querySelectorAll('article > .scroll').length, 1);
  } finally { s.dom.window.close(); }
});
test('manual chooser: offered for unresolved automatic bids, previews columns, cancels without changes', async () => {
  const s = await review([job('found')], false, { auto: true, entry: { extractionState: 'ready', extractionIssues: ['Строка 2: логин не определён'] } });
  try {
    s.w.document.querySelector('.pm-manual-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-modal-backdrop').shadowRoot;
    assert.match(root.textContent, /manual_profile/);
    assert.equal(root.querySelector('.pm-manual-apply').disabled, true);
    const delimiter = root.querySelector('.pm-manual-delimiter');
    delimiter.value = '|'; delimiter.dispatchEvent(new s.w.Event('change'));
    const column = root.querySelector('.pm-manual-column');
    column.value = '1'; column.dispatchEvent(new s.w.Event('change'));
    assert.equal(root.querySelector('.pm-manual-apply').disabled, false);
    assert.match(root.textContent, /Корректных значений: 1; останутся нераспознанными: 1/);
    await s.intervals[0](); await settle();
    assert.equal(s.w.document.querySelector('.pm-modal-backdrop').shadowRoot, root);
    root.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(s.w.document.querySelector('.pm-modal-backdrop'), null);
    assert.equal(s.messages.some(m => m.action === 'ai-manual-apply'), false);
  } finally { s.dom.window.close(); }
});
test('manual chooser: applying sends only the selection, never raw rows or new paid requests', async () => {
  const s = await review([], false, { auto: true, entry: { extractionState: 'error', extractionError: 'Synthetic unresolved login' } });
  try {
    s.w.document.querySelector('.pm-manual-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-modal-backdrop').shadowRoot;
    const delimiter = root.querySelector('.pm-manual-delimiter'); delimiter.value = '|'; delimiter.dispatchEvent(new s.w.Event('change'));
    const column = root.querySelector('.pm-manual-column'); column.value = '1'; column.dispatchEvent(new s.w.Event('change'));
    root.querySelector('.pm-manual-apply').click(); await settle();
    const msg = s.messages.find(m => m.action === 'ai-manual-apply');
    assert.equal(msg.bidId, '42'); assert.equal(msg.column, 1); assert.equal(msg.delimiter, '|');
    assert.equal(msg.digest, 'synthetic-digest');
    assert.doesNotMatch(JSON.stringify(msg), /SYNTHETIC_PASSWORD|manual_profile|mail@example/);
    assert.equal(s.w.document.querySelector('.pm-modal-backdrop'), null);
    assert.equal(s.messages.some(m => ['ai-extract', 'sc-submit', 'sc-refresh'].includes(m.action)), false);
  } finally { s.dom.window.close(); }
});
test('manual chooser: hidden for successful/pending or non-automatic bids', async () => {
  for (const extra of [{ auto: true, entry: { extractionState: 'ready' } },
    { auto: true, entry: { extractionState: 'pending', extractionError: 'Synthetic error' } }, {}]) {
    const s = await review([job('found')], false, extra);
    try { assert.equal(s.w.document.querySelector('.pm-manual-open'), null); }
    finally { s.dom.window.close(); }
  }
});
test('manual chooser: profile URL stays in one colon-delimited column; auto type is offered and sent', async () => {
  const s = await review([], false, { auto: true, entry: { extractionState: 'error', extractionError: 'Synthetic unresolved login' } });
  try {
    const send = s.w.chrome.runtime.sendMessage;
    s.w.chrome.runtime.sendMessage = async msg => {
      if (msg.action !== 'ai-manual-preview') return send(msg);
      s.messages.push(msg);
      return { ok: true, rows: [{ index: 0, value: 'https://facebook.com/profile.php?id=123456:SYNTHETIC_PASSWORD' }],
        digest: 'synthetic-digest', runId: 'synthetic-run', types: ['username', 'id'], platform: 'facebook' };
    };
    s.w.document.querySelector('.pm-manual-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-modal-backdrop').shadowRoot;
    assert.equal(root.querySelector('.pm-manual-type').value, 'auto');
    assert.deepEqual([...root.querySelectorAll('thead th')].map(n => n.textContent), ['Исходная строка', 'Столбец 1', 'Столбец 2']);
    assert.equal(root.querySelector('tbody td:nth-child(2)').textContent, 'https://facebook.com/profile.php?id=123456');
    const column = root.querySelector('.pm-manual-column'); column.value = '0'; column.dispatchEvent(new s.w.Event('change'));
    assert.equal(root.querySelector('.pm-manual-apply').disabled, false);
    root.querySelector('.pm-manual-apply').click(); await settle();
    const msg = s.messages.find(m => m.action === 'ai-manual-apply');
    assert.equal(msg.type, 'auto'); assert.equal(msg.column, 0);
    assert.doesNotMatch(JSON.stringify(msg), /SYNTHETIC_PASSWORD|123456/);
  } finally { s.dom.window.close(); }
});
test('diagnostics window is optional, renders source and responses as text and makes no paid requests', async () => {
  const s = await review([job('failed')], false, { diagnostics: {
    available: true, rowChoices: [{ id: 1, index: 0, time: 1000 }],
    rows: [{ id: 1, index: 0, time: 1000, value: 'test_profile:SYNTHETIC_PASSWORD' }],
    ai: [{ id: 2, attempt: 1, method: 'POST', endpoint: 'https://ai.example.test/v1/chat/completions',
      time: 1000, ended: 1500, status: 502, error: 'Synthetic gateway failure', body: '<script>window.executed=true</script>' }],
    social: [{ id: 3, attempt: 2, method: 'POST', endpoint: 'https://api.example.test/api/v1/checks',
      time: 2000, status: 500, body: '{"error":"SYNTHETIC_SERVICE_ERROR"}' }],
  } });
  try {
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), null);
    assert.doesNotMatch(s.w.document.getElementById('entries').textContent, /SYNTHETIC_PASSWORD/);
    s.w.document.querySelector('.pm-diagnostics-open').click(); await settle();
    const root = s.w.document.querySelector('.pm-diagnostics-backdrop').shadowRoot;
    assert.match(root.textContent, /test_profile:SYNTHETIC_PASSWORD/);
    assert.match(root.textContent, /Synthetic gateway failure/);
    assert.match(root.textContent, /SYNTHETIC_SERVICE_ERROR/);
    assert.equal(root.querySelector('script'), null); assert.equal(s.w.executed, undefined);
    root.querySelector('.pm-diagnostics-refresh').click(); await settle();
    assert.equal(s.messages.filter(m => m.action === 'sc-diagnostics').length, 2);
    assert.equal(s.messages.filter(m => ['sc-submit','sc-refresh','ai-extract'].includes(m.action)).length, 0);
    root.querySelector('.pm-diagnostics-close').click();
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), null);
    s.w.document.querySelector('.pm-diagnostics-open').click(); await settle();
    const again = s.w.document.querySelector('.pm-diagnostics-backdrop').shadowRoot;
    again.querySelector('.pm-diagnostics-select').value = 'row:1';
    again.querySelector('.pm-diagnostics-select').dispatchEvent(new s.w.Event('change')); await settle();
    assert.equal(s.messages.at(-1).rowId, 1);
    again.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), null);
  } finally { s.dom.window.close(); }
});
test('an open diagnostics window survives result redraws and does not pause automatic checks', async () => {
  const s = await review([job('found')], false, { auto: true, entry: { extractionState: 'pending' } });
  try {
    s.w.document.querySelector('.pm-diagnostics-open').click(); await settle();
    const modal = s.w.document.querySelector('.pm-diagnostics-backdrop');
    s.pack.auto = true;
    s.pack.entries[0].jobs.push({ query: { ...job('found').query, identifier: 'new_profile' }, key: 'new-key' });
    await s.intervals[0](); await settle();
    assert.equal(s.w.document.querySelector('.pm-diagnostics-backdrop'), modal);
    assert.equal(s.messages.filter(m => m.action === 'sc-submit').length, 1);
    assert.equal(s.messages.some(m => m.action === 'ai-cancel'), false);
  } finally { s.dom.window.close(); }
});
