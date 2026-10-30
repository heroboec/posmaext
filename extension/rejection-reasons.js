'use strict';

// Only user-provided reasons; no built-in list.
(() => {
  const normalize = values => values.map(value => value.trim()).filter(Boolean);
  globalThis.PM_REASONS = Object.freeze({
    read(value) {
      return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? normalize(value) : [];
    },
    parse(text) { return normalize(text.split(/\r\n?|\n/)); },
    label(text) { return text.length > 80 ? text.slice(0, 77) + '…' : text; },
  });
})();
