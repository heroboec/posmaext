'use strict';

// Pure helpers shared by the isolated content script, worker and review page.
const PM_SOCIAL = (() => {
  const defaults = { Instagram: 'instagram', Twitter: 'x', X: 'x', TikTok: 'tiktok', YouTube: 'youtube', Reddit: 'reddit' };
  const fields = { external_id: 'ID', username: 'Юзернейм', display_name: 'Имя', bio: 'Описание',
    profile_url: 'Ссылка', avatar_url: 'Аватар', registration_date: 'Регистрация', posts: 'Публикации',
    friends: 'Друзья', followers: 'Подписчики', following: 'Подписки' };
  const statuses = { pending: 'Ожидание', running: 'В обработке', found: 'Найден', not_found: 'Не найден',
    unavailable: 'Недоступно (не означает отсутствие)', failed: 'Ошибка' };
  const normalize = (type, value) => type === 'username' ? value.trim().replace(/^@/, '').toLowerCase() : value.trim();
  function valid(platform, type, value) {
    if (typeof value !== 'string') return false;
    value = normalize(type, value);
    if (type === 'id') return platform === 'tiktok' ? /^\d+$/.test(value) : platform === 'youtube' && /^UC[\w-]{22}$/.test(value);
    if (type !== 'username') return false;
    const patterns = { instagram: /^[a-zA-Z0-9._]{1,30}$/, x: /^[a-zA-Z0-9_]{1,15}$/,
      tiktok: /^[a-zA-Z0-9._]{1,24}$/, youtube: /^[a-zA-Z0-9_.-]{3,30}$/, reddit: /^[a-zA-Z0-9_-]{3,20}$/ };
    if (platform === 'instagram' && ['p', 'reel', 'reels', 'stories', 'explore'].includes(value)) return false;
    return !!patterns[platform]?.test(value);
  }
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
      .flatMap(p => p.identifier_types || []).filter(t => t === 'username' || t === 'id'))];
  }
  function serverSuccess(json) {
    return !!json && !json.error && json.status !== 'error' &&
      (json.code === 0 || json.status === 'ok' || json.status === 'success' || json.success === true);
  }
  return { defaults, fields, statuses, normalize, valid, rows, sample, types, serverSuccess };
})();
