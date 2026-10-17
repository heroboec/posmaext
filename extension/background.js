'use strict';

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
