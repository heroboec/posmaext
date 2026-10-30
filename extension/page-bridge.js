'use strict';

// Runs in the page's MAIN world: jQuery .trigger('change') and direct calls do not
// necessarily dispatch the native DOM change event seen by the content script.
(() => {
  function install() {
    const bids = window.admin_bids;
    if (!bids || typeof bids.change_status !== 'function') return false;
    const original = bids.change_status;
    bids.change_status = function (bidId, status, ...args) {
      if (String(status) === '4' && /^\d+$/.test(String(bidId))) {
        const select = document.getElementById(`status_id${bidId}`);
        if (select instanceof HTMLSelectElement) {
          const event = new Event('pm-request-decline', { bubbles: true, cancelable: true });
          if (!select.dispatchEvent(event)) return false;
        }
      }
      return original.call(this, bidId, status, ...args);
    };
    return true;
  }
  if (!install()) {
    let attempts = 0;
    const timer = setInterval(() => {
      if (install() || ++attempts >= 60) clearInterval(timer);
    }, 500);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  }
})();
