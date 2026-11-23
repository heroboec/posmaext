'use strict';

// Pure helpers shared by the isolated content script, worker and review page.
const PM_SOCIAL = (() => {
  // One shared 3/s budget, with a small margin for network/server scheduling jitter.
  const retryLimit = 10, aiRetryLimit = 3, retryDelay = 2000, apiInterval = 350;
  const apiMinuteLimit = 300, apiMinuteWindow = 60000, pollInterval = 10000;
  const defaults = { Instagram: 'instagram', Twitter: 'x', X: 'x', 'x.com(Twitter)': 'x',
    TikTok: 'tiktok', YouTube: 'youtube', Reddit: 'reddit', Facebook: 'facebook' };
  const supported = { instagram: ['username'], facebook: ['username', 'id'], x: ['username'],
    tiktok: ['username', 'id'], youtube: ['username', 'id'], reddit: ['username'] };
  const hosts = { instagram: ['instagram.com', 'www.instagram.com'], facebook: ['facebook.com', 'www.facebook.com'],
    x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], tiktok: ['tiktok.com', 'www.tiktok.com'],
    youtube: ['youtube.com', 'www.youtube.com'], reddit: ['reddit.com', 'www.reddit.com'] };
  const reserved = {
    instagram: ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct'],
    facebook: ['share', 'sharer', 'sharer.php', 'profile.php', 'watch', 'reel', 'reels', 'stories',
      'groups', 'events', 'marketplace', 'login', 'pages', 'photo.php'],
    x: ['home', 'explore', 'search', 'i', 'intent', 'settings', 'messages', 'notifications', 'login', 'signup'],
  };
  const fields = { external_id: 'ID', username: 'Юзернейм', display_name: 'Имя', bio: 'Описание',
    profile_url: 'Ссылка', avatar_url: 'Аватар', registration_date: 'Регистрация', posts: 'Публикации',
    friends: 'Друзья', followers: 'Подписчики', following: 'Подписки' };
  const statuses = { pending: 'Ожидание', running: 'В обработке', found: 'Найден', not_found: 'Не найден',
    unavailable: 'Недоступно (не означает отсутствие)', failed: 'Ошибка' };
  const normalize = (type, value) => type === 'username' ? value.trim().replace(/^@/, '').toLowerCase() : value.trim();
  function valid(platform, type, value) {
    if (typeof value !== 'string') return false;
    value = normalize(type, value);
    if (type === 'id') return ['facebook', 'tiktok'].includes(platform) ? /^\d{1,100}$/.test(value) : platform === 'youtube' && /^UC[\w-]{22}$/.test(value);
    if (type !== 'username') return false;
    const patterns = { instagram: /^[a-zA-Z0-9._]{1,30}$/, x: /^[a-zA-Z0-9_]{1,15}$/,
      facebook: /^[a-zA-Z0-9_.-]{1,100}$/, tiktok: /^[a-zA-Z0-9._]{1,24}$/,
      youtube: /^[a-zA-Z0-9_.-]{3,30}$/, reddit: /^[a-zA-Z0-9_-]{3,20}$/ };
    if (reserved[platform]?.includes(value)) return false;
    return !!patterns[platform]?.test(value);
  }
  function profileURL(platform, value) {
    // No network, redirect following, decoding blobs or accepting arbitrary hosts.
    if (typeof value !== 'string' || value.length > 500 || !/^https:\/\//i.test(value) ||
        /[\s\\%]/.test(value)) return null;
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    if (!hosts[platform]?.includes(url.hostname) || url.username || url.password || url.port || url.hash ||
        value.includes('#') || /\/\.{1,2}(?:\/|$)/.test(value)) return null;
    // Check the original authority as URL() silently drops a default :443 port.
    if (!hosts[platform].includes(value.slice(8).split('/')[0].toLowerCase())) return null;
    const parts = url.pathname.replace(/^\/|\/$/g, '').split('/');
    let type = 'username', identifier;
    if (platform === 'facebook' && url.pathname === '/profile.php' && /^\?id=\d+$/.test(url.search)) {
      type = 'id'; identifier = url.search.slice(4);
    } else {
      if (url.search || value.includes('?')) return null;
      if (platform === 'reddit' && parts.length === 2 && ['u', 'user'].includes(parts[0])) identifier = parts[1];
      else if (platform === 'youtube' && parts.length === 2 && parts[0] === 'channel') {
        type = 'id'; identifier = parts[1];
      } else if (parts.length === 1 && platform !== 'reddit') {
        identifier = parts[0];
        if (['tiktok', 'youtube'].includes(platform) && !identifier.startsWith('@')) return null;
        if (platform === 'facebook' && /^\d+$/.test(identifier)) type = 'id';
      } else return null;
    }
    return valid(platform, type, identifier) ? { type, identifier: normalize(type, identifier) } : null;
  }
  function resolve(platform, type, value, allowed = supported[platform] || []) {
    if (typeof value !== 'string' || !['auto', 'url', 'username', 'id'].includes(type)) return null;
    value = value.trim();
    const url = /^https?:\/\//i.test(value);
    let result;
    if (url) {
      result = profileURL(platform, value);
      if (!result || (type === 'id' && result.type !== 'id')) return null;
    } else {
      if (type === 'url') return null;
      if (platform === 'facebook' && /^\d+$/.test(value.replace(/^@/, ''))) value = value.replace(/^@/, '');
      const kind = (platform === 'facebook' && /^\d+$/.test(value)) ||
        (type === 'auto' && ((platform === 'tiktok' && /^\d+$/.test(value)) ||
          (platform === 'youtube' && /^UC[\w-]{22}$/.test(value)))) ? 'id' :
        type === 'auto' ? 'username' : type;
      if (!valid(platform, kind, value)) return null;
      result = { type: kind, identifier: normalize(kind, value) };
    }
    return allowed.includes(result.type) ? result : null;
  }
  // A scheme colon is part of the link, not a separate account column.
  const splitColumns = (row, delimiter) => delimiter === ':' ? row.split(/:(?!\/\/)/) : row.split(delimiter);
  function rows(response) {
    if (response?.code !== 0 || !Array.isArray(response.list) || response.list.some(x => typeof x?.data !== 'string')) {
      throw new Error('Неожиданный ответ списка товаров (ожидается code: 0 и list[].data)');
    }
    return response.list.map(x => x.data.split(':'));
  }
  function sample(rows, column, platform, type, random = Math.random) {
    const width = Math.max(0, ...rows.map(r => r.length));
    const values = [...new Set(rows.filter(r => r.length === width && r.every(v => v.trim()))
      .map(r => r[column] === undefined ? '' : normalize(type, r[column])).filter(v => valid(platform, type, v)))];
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values.slice(0, 2);
  }
  function types(catalog, platform) {
    return [...new Set((catalog || []).filter(p => p.platform === platform && p.object_type === 'profile' && p.operation === 'fetch')
      .flatMap(p => p.identifier_types || []).filter(t => supported[platform]?.includes(t)))];
  }
  function serverSuccess(json) {
    return !!json && !json.error && json.status !== 'error' &&
      (json.code === 0 || json.status === 'ok' || json.status === 'success' || json.success === true);
  }
  function manualColumn(rows, indexes, delimiter, column, platform, type, allowed) {
    if (![':', ';', '|', '\t'].includes(delimiter) || !Number.isInteger(column) || column < 0 || column > 1000) throw new Error('Выберите разделитель и столбец');
    return indexes.map(index => {
      const value = splitColumns(rows[index], delimiter)[column]?.trim() || '';
      const result = resolve(platform, type, value, allowed);
      return { index, identifier: result?.identifier || null, type: result?.type || null };
    });
  }
  function legacyTransient(job) {
    return /^(Сетевой сбой\.|API вернул некорректный JSON|Некорректный ответ проверки|Лимит API:|Биллинг временно недоступен|API: HTTP (408|425|429|5\d\d)\b)/.test(job.error || '');
  }
  function resumeAttempts(job, action) {
    if (job.requestAction === action && ['queued', 'sending', 'retry_wait'].includes(job.requestState)) return job.attemptCount || 0;
    if (!job.requestState && job.attempted && ((action === 'sc-submit' && !job.error) || legacyTransient(job))) return (job.retryCount || 0) + 1;
    return 0;
  }
  function autoAction(job) {
    const action = job.check?.id ? 'sc-refresh' : 'sc-submit';
    if (action === 'sc-submit' && job.rejected) return null;
    if (action === 'sc-refresh' && !['pending', 'running'].includes(job.check.status)) return null;
    if (job.requestAction === action && ['failed', 'paused'].includes(job.requestState)) return null;
    const resuming = job.requestAction === action && ['queued', 'sending', 'retry_wait'].includes(job.requestState);
    if (resuming) return resumeAttempts(job, action) < retryLimit + 1 ? action : null;
    if (action === 'sc-refresh' && job.nextPollAt > Date.now()) return null;
    if (job.error && !legacyTransient(job)) return null;
    if (job.error && (job.retryCount || 0) >= retryLimit) return null;
    if (resumeAttempts(job, action) >= retryLimit + 1) return null;
    if (action === 'sc-submit' && job.attempted && job.requestState) return null;
    return action;
  }
  return { defaults, fields, statuses, normalize, valid, rows, sample, types, serverSuccess, manualColumn,
    profileURL, resolve, splitColumns, autoAction, resumeAttempts,
    retryLimit, aiRetryLimit, retryDelay, apiInterval, apiMinuteLimit, apiMinuteWindow, pollInterval };
})();
