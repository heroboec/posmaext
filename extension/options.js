'use strict';

const statusEl = document.getElementById('status');
const GITHUB_REPO = 'heroboec/posmaext';
const resultEl = document.getElementById('update-result');
const currentVersion = chrome.runtime.getManifest().version;

document.getElementById('current-version').textContent = currentVersion;

// Same cleanup as in background.js, in case the worker hasn't run onInstalled yet.
chrome.storage.local.remove(['csvData', 'savedMatches', 'appliedBids', 'catalogUrls', 'invalidThreshold', 'githubRepo']);

chrome.storage.local.get(['urlPatterns'], (r) => {
  document.getElementById('url-patterns').value = (r.urlPatterns || []).join('\n');
});

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

document.getElementById('save-btn').addEventListener('click', () => {
  const patterns = document.getElementById('url-patterns').value
    .split('\n').map(l => l.trim()).filter(Boolean);

  chrome.storage.local.set({ urlPatterns: patterns }, () => {
    if (chrome.runtime.lastError) {
      setStatus(`Ошибка хранилища: ${chrome.runtime.lastError.message}`, false);
      return;
    }
    setStatus(`✓ Сохранено (паттернов: ${patterns.length})`, true);
  });
});

// ── Updates ───────────────────────────────────────────────────────────────────

// "2.10" > "2.9"; missing parts count as 0.
function compareVersions(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function showResult(text, color, link) {
  resultEl.textContent = '';
  resultEl.style.color = color;
  resultEl.appendChild(document.createTextNode(text));
  if (link) {
    resultEl.appendChild(document.createTextNode(' '));
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.text;
    resultEl.appendChild(a);
  }
}

async function checkUpdates() {
  showResult('Проверяю…', '#555');
  let resp;
  try {
    resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch (e) {
    showResult(`✗ Нет связи с GitHub: ${e.message}`, '#c0392b');
    return;
  }
  if (resp.status === 404) {
    showResult('✗ Релизов нет, либо репозиторий не найден или приватный', '#c0392b');
    return;
  }
  if (!resp.ok) {
    showResult(`✗ GitHub ответил ${resp.status}${resp.status === 403 ? ' (лимит запросов, попробуйте позже)' : ''}`, '#c0392b');
    return;
  }

  const release = await resp.json();
  const latest = String(release.tag_name || '').replace(/^v/i, '');
  const asset = (release.assets || []).find(a => a.name.toLowerCase().endsWith('.zip'));
  const href = asset ? asset.browser_download_url : release.html_url;

  if (!latest) { showResult('✗ У релиза нет тега с версией', '#c0392b'); return; }
  if (compareVersions(latest, currentVersion) > 0) {
    showResult(`Доступна версия ${latest} (у вас ${currentVersion}).`, '#1e8449',
      { href, text: asset ? `Скачать ${asset.name}` : 'Открыть релиз' });
  } else {
    showResult(`✓ Установлена последняя версия (${currentVersion}).`, '#2a7a2a',
      { href: release.html_url, text: 'Релиз на GitHub' });
  }
}

document.getElementById('check-btn').addEventListener('click', checkUpdates);
document.getElementById('reload-btn').addEventListener('click', () => chrome.runtime.reload());
