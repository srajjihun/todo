'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../src/main/store');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-test-'));
  return path.join(dir, name);
}

test('저장 후 다시 로드하면 같은 데이터', () => {
  const file = tmpFile('s.json');
  const a = new JsonStore(file, { x: 1, y: 'a' });
  a.update({ x: 42, z: true });
  const b = new JsonStore(file, { x: 1, y: 'a' });
  assert.equal(b.data.x, 42);
  assert.equal(b.data.y, 'a');
  assert.equal(b.data.z, true);
});

test('손상된 파일이면 기본값으로 복구', () => {
  const file = tmpFile('bad.json');
  fs.writeFileSync(file, '{invalid json!!!', 'utf8');
  const s = new JsonStore(file, { ok: 'default' });
  assert.equal(s.data.ok, 'default');
});

test('reset은 파일 삭제 + 기본값 복원', () => {
  const file = tmpFile('r.json');
  const s = new JsonStore(file, { v: 0 });
  s.update({ v: 9 });
  assert.ok(fs.existsSync(file));
  s.reset();
  assert.ok(!fs.existsSync(file));
  assert.equal(s.data.v, 0);
});

test('원자적 쓰기: tmp 파일이 남지 않음', () => {
  const file = tmpFile('a.json');
  const s = new JsonStore(file, {});
  s.update({ big: 'x'.repeat(10000) });
  assert.ok(!fs.existsSync(file + '.tmp'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).big.length, 10000);
});

test('기본값 객체는 인스턴스 간 공유되지 않음', () => {
  const defaults = { nested: { list: [] } };
  const s1 = new JsonStore(tmpFile('n1.json'), defaults);
  s1.data.nested.list.push('oops');
  const s2 = new JsonStore(tmpFile('n2.json'), defaults);
  assert.equal(s2.data.nested.list.length, 0);
});
