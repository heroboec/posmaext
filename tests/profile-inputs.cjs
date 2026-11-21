const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({ URL });
vm.runInContext(fs.readFileSync('extension/social-common.js', 'utf8') + '\nglobalThis.common = PM_SOCIAL;', ctx);
const common = ctx.common;
const plain = value => JSON.parse(JSON.stringify(value));

test('profile inputs: all requested platforms accept handles and matching profile URLs', () => {
  const examples = [
    ['instagram', '@Demo.Profile', 'username', 'demo.profile'],
    ['instagram', 'https://www.instagram.com/Demo.Profile/', 'username', 'demo.profile'],
    ['facebook', 'Demo.Profile', 'username', 'demo.profile'],
    ['facebook', 'https://www.facebook.com/Demo.Profile', 'username', 'demo.profile'],
    ['facebook', '123456', 'id', '123456'],
    ['facebook', 'https://facebook.com/123456/', 'id', '123456'],
    ['facebook', 'https://www.facebook.com/profile.php?id=123456', 'id', '123456'],
    ['x', '@demo_profile', 'username', 'demo_profile'],
    ['x', 'https://x.com/Demo_Profile', 'username', 'demo_profile'],
    ['x', 'https://www.twitter.com/Demo_Profile/', 'username', 'demo_profile'],
    ['tiktok', '@demo.profile', 'username', 'demo.profile'],
    ['tiktok', 'https://www.tiktok.com/@Demo.Profile/', 'username', 'demo.profile'],
    ['tiktok', '123456', 'id', '123456'],
    ['tiktok', 'https://tiktok.com/@123456', 'username', '123456'],
    ['reddit', 'demo_profile', 'username', 'demo_profile'],
    ['reddit', 'https://www.reddit.com/user/Demo_Profile/', 'username', 'demo_profile'],
    ['reddit', 'https://reddit.com/u/Demo_Profile', 'username', 'demo_profile'],
    ['youtube', 'https://youtube.com/@Demo.Profile', 'username', 'demo.profile'],
    ['youtube', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', 'id', 'UCabcdefghijklmnopqrstuv'],
    ['youtube', 'UCabcdefghijklmnopqrstuv', 'id', 'UCabcdefghijklmnopqrstuv'],
  ];
  for (const [platform, value, type, identifier] of examples) {
    assert.deepEqual(plain(common.resolve(platform, 'auto', value)), { type, identifier }, platform + ' ' + value);
  }
  assert.equal(common.defaults.Facebook, 'facebook');
  assert.equal(common.resolve('facebook', 'username', '123456').type, 'id');
  assert.equal(common.resolve('tiktok', 'username', '123456').type, 'username');
});
test('profile inputs: non-profile paths, spoofed hosts, credentials, tracking and encoded URL tricks are rejected', () => {
  const examples = [
    ['instagram', 'https://instagram.com/p/ABC'], ['instagram', 'https://instagram.com/reel/ABC'],
    ['instagram', 'https://instagram.com/stories/demo.profile/123'],
    ['x', 'https://twitter.com/demo_profile/status/123'], ['x', 'https://x.com/home'],
    ['tiktok', 'https://tiktok.com/@demo.profile/video/123'], ['tiktok', 'https://vm.tiktok.com/ABC'],
    ['tiktok', 'https://tiktok.com/123456'], ['reddit', 'https://reddit.com/r/example'],
    ['reddit', 'https://reddit.com/user/demo_profile/comments/123'],
    ['facebook', 'https://facebook.com/share/ABC'], ['facebook', 'https://facebook.com/groups/123'],
    ['facebook', 'https://facebook.com/watch'], ['facebook', 'https://facebook.com/profile.php?id=abc'],
    ['facebook', 'https://facebook.com/profile.php?id=123&id=456'],
    ['facebook', 'https://facebook.com/profile.php?id=123&token=SYNTHETIC'],
    ['facebook', 'https://facebook.com/demo.profile?tracking=1'],
    ['facebook', 'https://facebook.com/demo.profile#fragment'],
    ['facebook', 'https://facebook.com.evil.example/demo.profile'],
    ['facebook', 'https://facebook.com@evil.example/demo.profile'],
    ['facebook', 'https://evil.example@facebook.com/demo.profile'],
    ['facebook', 'http://facebook.com/demo.profile'],
    ['facebook', 'https://facebook.com:443/demo.profile'],
    ['facebook', 'https://facebook.com/%64emo.profile'],
    ['facebook', 'https://facebook.com/share/../demo.profile'],
    ['facebook', 'https://facebook.com\\demo.profile'],
    ['facebook', 'mail@example.test'], ['facebook', '{"name":"sessionid","value":"SYNTHETIC_COOKIE"}'],
    ['instagram', 'Mozilla/5.0'], ['tiktok', 'sessionid=SYNTHETIC_SESSION'],
    ['instagram', 'https://facebook.com/demo.profile'],
  ];
  for (const [platform, value] of examples) assert.equal(common.resolve(platform, 'auto', value), null, value);
});
test('profile inputs: supported canonical types remain constrained by the server catalog', () => {
  const catalog = [{ platform: 'facebook', object_type: 'profile', operation: 'fetch', identifier_types: ['username', 'id', 'url'] }];
  assert.deepEqual(plain(common.types(catalog, 'facebook')), ['username', 'id']);
  assert.deepEqual(plain(common.types(catalog, 'instagram')), []);
  assert.equal(common.resolve('facebook', 'auto', '123456', ['username']), null);
  assert.equal(common.resolve('facebook', 'auto', 'https://facebook.com/profile.php?id=123456', ['username']), null);
  assert.equal(common.resolve('tiktok', 'id', 'https://tiktok.com/@demo.profile'), null);
  assert.equal(common.resolve('instagram', 'id', '123456'), null);
  assert.equal(common.resolve('reddit', 'id', '123456'), null);
});
test('profile inputs: manual columns preserve URL schemes and normalize mixed identifiers without email fragments', () => {
  const rows = ['https://facebook.com/Demo.Profile:SYNTHETIC_PASSWORD', '123456:SYNTHETIC_PASSWORD',
    'https://facebook.com/profile.php?id=123456:SYNTHETIC_PASSWORD', 'mail@example.test:SYNTHETIC_PASSWORD'];
  assert.deepEqual(plain(common.splitColumns(rows[0], ':')), ['https://facebook.com/Demo.Profile', 'SYNTHETIC_PASSWORD']);
  const selected = common.manualColumn(rows, [0, 1, 2, 3], ':', 0, 'facebook', 'auto', ['username', 'id']);
  assert.deepEqual(plain(selected), [{ index: 0, type: 'username', identifier: 'demo.profile' },
    { index: 1, type: 'id', identifier: '123456' }, { index: 2, type: 'id', identifier: '123456' },
    { index: 3, type: null, identifier: null }]);
});
