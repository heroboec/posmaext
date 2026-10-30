'use strict';

// Labels and messages are supplied by the user, never built into the extension.
(() => {
  const entry = value => {
    if (typeof value === 'string') return { label: '', text: value.trim() };
    if (!value || typeof value.text !== 'string') return null;
    return { label: typeof value.label === 'string' ? value.label.trim() : '', text: value.text.trim() };
  };
  const splitAt = line => {
    const tab = line.indexOf('\t'), pipe = line.indexOf(' | ');
    if (tab >= 0 && (pipe < 0 || tab < pipe)) return [tab, 1];
    return pipe >= 0 ? [pipe, 3] : [-1, 0];
  };
  const read = values => Array.isArray(values) ? values.map(entry).filter(v => v?.text) : [];
  globalThis.PM_REASONS = Object.freeze({
    read,
    parse(text) {
      return text.split(/\r\n?|\n/).flatMap((line, index) => {
        if (!line.trim()) return [];
        const [at, length] = splitAt(line);
        const value = at < 0 ? { label: '', text: line.trim() } :
          { label: line.slice(0, at).trim(), text: line.slice(at + length).trim() };
        if (!value.text) throw new Error(`В строке ${index + 1} не указан текст причины.`);
        return [value];
      });
    },
    format(values) {
      return read(values).map(v => v.label || splitAt(v.text)[0] >= 0
        ? `${v.label}\t${v.text}` : v.text).join('\n');
    },
    text(value) { return entry(value)?.text || ''; },
    label(value) {
      const v = entry(value);
      const text = v?.label || v?.text || '';
      return text.length > 80 ? text.slice(0, 77) + '…' : text;
    },
  });
})();
