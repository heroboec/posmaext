'use strict';

// Keys left by the old full version (CSV base etc.). csvData alone can exceed the
// 10 MB storage quota, which makes every later write fail — drop them on install/update.
const PM_OBSOLETE_KEYS = ['csvData', 'savedMatches', 'appliedBids', 'catalogUrls', 'invalidThreshold'];
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove(PM_OBSOLETE_KEYS));

// Toolbar icon → settings page (version check lives there).
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Content scripts can't reliably open many tabs (popup blocker), so they ask us.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action !== 'open-tab' || !msg.url) return;
  chrome.tabs.create({
    url: msg.url,
    active: false,
    index: sender.tab ? sender.tab.index + 1 : undefined,
    openerTabId: sender.tab?.id,
  });
});
