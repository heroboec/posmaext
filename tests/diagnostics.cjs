const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function diagnostics() {
  let clock = 1000;
  const ctx = vm.createContext({ Date: class extends Date { static now() { return clock; } } });
  vm.runInContext(fs.readFileSync('extension/diagnostics.js', 'utf8') + '\nglobalThis.diag = PM_DIAG;', ctx);
  return { diag: ctx.diag, advance: ms => { clock += ms; } };
}
const query = identifier => ({ platform: 'instagram', identifier_type: 'username', identifier });
test('diagnostics: scoped rows, AI attempts and Social Check responses are linked to the correct account', () => {
  const { diag } = diagnostics();
  diag.rows('p', '42', 'context', ['first:TEST_PASSWORD', 'second:OTHER_TEST_PASSWORD']);
  diag.rows('p', '43', 'other', ['OTHER_BID_SECRET']);
  const a = diag.start({ kind: 'ai', packId: 'p', bidId: '42', contextId: 'context', indexes: [0], attempt: 1 });
  diag.update(a, { body: 'FIRST_AI_RESPONSE', status: 200 });
  const b = diag.start({ kind: 'ai', packId: 'p', bidId: '42', contextId: 'context', indexes: [1], attempt: 2 });
  diag.update(b, { body: 'SECOND_AI_RESPONSE', status: 500 });
  diag.link('p','42','context',0,query('first')); diag.link('p','42','context',1,query('second'));
  const s = diag.start({ kind: 'social', packId: 'p', bidId: '42', queryKey: diag.queryKey(query('first')) });
  diag.update(s, { body: 'FIRST_SOCIAL_RESPONSE' });
  const selected = diag.get('p','42',query('first'));
  assert.equal(selected.rows.length, 1); assert.equal(selected.rows[0].value, 'first:TEST_PASSWORD');
  assert.equal(selected.ai.length, 1); assert.equal(selected.ai[0].body, 'FIRST_AI_RESPONSE');
  assert.equal(selected.social[0].body, 'FIRST_SOCIAL_RESPONSE');
  assert.doesNotMatch(JSON.stringify(selected), /OTHER_BID_SECRET|OTHER_TEST_PASSWORD|SECOND_AI_RESPONSE/);
  const row = diag.get('p','42',undefined,selected.rowChoices[1].id);
  assert.equal(row.rows[0].value, 'second:OTHER_TEST_PASSWORD');
  assert.equal(row.ai[0].body, 'SECOND_AI_RESPONSE'); assert.equal(row.social.length, 0);
});
test('diagnostics: response parsing preserves malformed bodies and masks known authentication keys', async () => {
  const { diag } = diagnostics();
  diag.addSecrets(['SYNTHETIC_AUTH_KEY']);
  const id = diag.start({ kind: 'ai', packId: 'p', bidId: '42', indexes: [] });
  const result = await diag.capture({ status: 502, text: async () => '<html>SYNTHETIC_AUTH_KEY gateway failure</html>' }, id);
  assert.throws(() => result.json());
  const data = diag.get('p','42');
  assert.match(data.ai[0].body, /gateway failure/);
  assert.doesNotMatch(JSON.stringify(data), /SYNTHETIC_AUTH_KEY/);
  assert.match(data.ai[0].body, /API-ключ скрыт/);
});
test('diagnostics: oversized bodies are explicitly truncated, expired and deleted records disappear', () => {
  const { diag, advance } = diagnostics();
  const id = diag.start({ kind: 'ai', packId: 'p', bidId: '42', indexes: [] });
  diag.update(id, { body: 'x'.repeat(600000) });
  assert.equal(diag.get('p','42').ai[0].truncated, true);
  assert.equal(diag.get('p','42').ai[0].originalLength, 600000);
  advance(3600001);
  assert.equal(diag.get('p','42').available, false);
  assert.equal(diag.get('p','42').truncated, true);
  diag.rows('p','42','ctx',['TEST_PASSWORD']); diag.clear('p');
  assert.equal(diag.get('p','42').available, false);
});
test('diagnostics: memory limit evicts old responses with an explicit warning', () => {
  const { diag } = diagnostics();
  const body = 'SYNTHETIC_RESPONSE_'.padEnd(450000, 'x');
  for (let i = 0; i < 20; i++) {
    const id = diag.start({ kind: 'ai', packId: 'p', bidId: '42', indexes: [], attempt: i + 1 });
    diag.update(id, { body });
  }
  const data = diag.get('p','42');
  assert.equal(data.truncated, true);
  assert.ok(data.ai.length > 0 && data.ai.length < 20);
});
