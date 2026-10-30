'use strict';

// Shared by the settings page and isolated content scripts.
(() => {
  const defaults = [];

  const labels = [];

  const normalize = values => values.map(value => value.trim()).filter(Boolean);
  globalThis.PM_REASONS = Object.freeze({
    defaults: Object.freeze(defaults),
    read(value) {
      return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? normalize(value) : [...defaults];
    },
    parse(text) { return normalize(text.split(/\r\n?|\n/)); },
    label(text) {
      const index = defaults.indexOf(text);
      return index >= 0 ? labels[index] : (text.length > 80 ? text.slice(0, 77) + '…' : text);
    },
  });
})();
