'use strict';

const aiOption = id => document.getElementById('ai-' + id);
const aiOptionPresets = {
  openai: { url: 'https://api.openai.com/v1/', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'] },
  deepseek: { url: 'https://api.deepseek.com/', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  custom: { url: '', models: [] },
};
function aiOptionsModels(models) {
  aiOption('models').replaceChildren();
  for (const model of models) { const option = document.createElement('option'); option.value = model; aiOption('models').append(option); }
}
async function aiOptionsMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'Нет связи с расширением');
  return result;
}
async function aiOptionsLoad() {
  const c = await aiOptionsMessage({ action: 'ai-config-get' });
  aiOption('provider').value = c.provider;
  aiOption('url').value = c.url; aiOption('model').value = c.model;
  aiOption('concurrency').value = c.concurrency;
  aiOptionsModels(aiOptionPresets[c.provider]?.models || []);
  aiOption('key-state').textContent = c.hasKey
    ? 'Ключ сохранён. Пустое поле сохраняет его только для того же адреса. При смене адреса введите новый ключ.'
    : 'Ключ ИИ не задан.';
  aiOption('save').disabled = false; aiOption('test').disabled = !c.hasKey;
}
aiOption('provider').onchange = () => {
  const preset = aiOptionPresets[aiOption('provider').value];
  aiOption('url').value = preset.url; aiOption('model').value = preset.models[0] || '';
  aiOptionsModels(preset.models);
  aiOption('key').value = '';
  aiOption('test').disabled = true;
  aiOption('status').textContent = 'Пресет выбран. Укажите ключ и сохраните настройки.';
};
aiOption('url').addEventListener('input', () => {
  aiOption('key').value = ''; aiOption('test').disabled = true;
  aiOption('status').textContent = 'Адрес изменён. Укажите ключ для нового сервера и сохраните.';
});
aiOption('save').onclick = async () => {
  aiOption('save').disabled = true;
  try {
    const url = new URL(aiOption('url').value.trim());
    if (!await chrome.permissions.request({ origins: [url.origin + '/*'] })) throw new Error('Доступ к серверу ИИ не разрешён');
    await aiOptionsMessage({ action: 'ai-config-save', config: {
      provider: aiOption('provider').value, url: url.href, model: aiOption('model').value.trim(),
      key: aiOption('key').value.trim(), clearKey: aiOption('clear-key').checked,
      concurrency: aiOption('concurrency').value,
    } });
    aiOption('key').value = ''; aiOption('clear-key').checked = false;
    await aiOptionsLoad(); aiOption('status').textContent = 'Настройки ИИ сохранены. Можно проверить связь.';
  } catch (e) { aiOption('status').textContent = e.message; }
  finally { aiOption('save').disabled = false; }
};
aiOption('test').onclick = async () => {
  aiOption('test').disabled = true;
  try {
    const result = await aiOptionsMessage({ action: 'ai-models' });
    aiOptionsModels(result.models);
    aiOption('status').textContent = result.models.includes(aiOption('model').value)
      ? `Связь есть, выбранная модель доступна. Моделей: ${result.models.length}.`
      : 'Связь есть. Выберите доступную модель и сохраните. Некоторые серверы не перечисляют все модели.';
  } catch (e) { aiOption('status').textContent = e.message; }
  finally { aiOption('test').disabled = false; }
};
aiOptionsLoad().catch(e => { aiOption('status').textContent = e.message; });
