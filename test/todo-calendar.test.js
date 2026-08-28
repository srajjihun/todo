'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../src/main/sync-logic');

test('parseLedger: done_YYYY-MM 키만 읽고 정렬한다', () => {
  const l = logic.parseLedger({ 'done_2026-09': '5,1,3', 'other': 'x', 'done_2026-10': '2', 'done_bad': '1' });
  assert.deepEqual(l, { '2026-09': [1, 3, 5], '2026-10': [2] });
});

test('parseLedger: 빈 값/이상값은 버린다', () => {
  assert.deepEqual(logic.parseLedger({ 'done_2026-09': '', 'done_2026-10': '0,99,abc' }), {});
  assert.deepEqual(logic.parseLedger(null), {});
});

test('ledgerHas', () => {
  const l = { '2026-09': [1, 3] };
  assert.equal(logic.ledgerHas(l, '2026-09-01'), true);
  assert.equal(logic.ledgerHas(l, '2026-09-02'), false);
  assert.equal(logic.ledgerHas(l, '2026-10-01'), false);
  assert.equal(logic.ledgerHas(null, '2026-09-01'), false);
});

test('ledgerSet: 추가/제거, 마지막 항목 제거 시 null', () => {
  assert.deepEqual(logic.ledgerSet({ '2026-09': [1, 3] }, '2026-09-02', true),
    { month: '2026-09', days: [1, 2, 3], value: '1,2,3' });
  assert.deepEqual(logic.ledgerSet({ '2026-09': [1, 3] }, '2026-09-03', false),
    { month: '2026-09', days: [1], value: '1' });
  assert.deepEqual(logic.ledgerSet({ '2026-09': [3] }, '2026-09-03', false),
    { month: '2026-09', days: [], value: null });
  // 없는 달에 추가
  assert.deepEqual(logic.ledgerSet({}, '2026-11-07', true),
    { month: '2026-11', days: [7], value: '7' });
});

test('ledgerSet: 같은 날 중복 체크해도 하루만', () => {
  assert.deepEqual(logic.ledgerSet({ '2026-09': [1] }, '2026-09-01', true).days, [1]);
});

test('normalizeTodoMaster: 반복 규칙과 원장을 뽑는다', () => {
  const m = logic.normalizeTodoMaster({
    id: 'm1', summary: '헬스', etag: '"abc"',
    recurrence: ['RRULE:FREQ=DAILY'],
    extendedProperties: { private: { wtype: 'todo', 'done_2026-09': '1' } },
  }, 'cal1');
  assert.equal(m.id, 'm1');
  assert.equal(m.calendarId, 'cal1');
  assert.equal(m.title, '헬스');
  assert.deepEqual(m.recurrence, ['RRULE:FREQ=DAILY']);
  assert.deepEqual(m.ledger, { '2026-09': [1] });
});

test('buildTodoOccurrences: 인스턴스를 마스터에 조인하고 완료 상태를 붙인다', () => {
  const masters = {
    m1: { id: 'm1', calendarId: 'c', title: '헬스', recurrence: ['RRULE:FREQ=DAILY'], ledger: { '2026-09': [1] } },
  };
  const events = [
    { id: 'm1_20260901', recurringEventId: 'm1', title: '헬스', startDate: '2026-09-01' },
    { id: 'm1_20260902', recurringEventId: 'm1', title: '헬스', startDate: '2026-09-02' },
    { id: 'other', recurringEventId: null, title: '남의 일정', startDate: '2026-09-02' },
  ];
  const occ = logic.buildTodoOccurrences(events, masters);
  assert.equal(occ.length, 2, '마스터에 속한 것만 포함');
  assert.equal(occ[0].status, 'completed');
  assert.equal(occ[1].status, 'needsAction');
  assert.equal(occ[0].masterId, 'm1');
  assert.equal(occ[0].repeating, true);
  assert.equal(occ[0].kind, 'occ');
});

test('buildTodoOccurrences: 반복 아닌 단일 일정도 자기 id로 조인된다', () => {
  const masters = { s1: { id: 's1', calendarId: 'c', title: '단발', recurrence: null, ledger: {} } };
  const occ = logic.buildTodoOccurrences([{ id: 's1', recurringEventId: null, title: '단발', startDate: '2026-09-05' }], masters);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].repeating, false);
});

test('normalizeEvent: calendarId와 recurringEventId를 보존한다', () => {
  const e = logic.normalizeEvent({
    id: 'x_1', summary: '헬스', recurringEventId: 'x',
    start: { date: '2026-09-01' }, end: { date: '2026-09-02' },
  }, 'cal9');
  assert.equal(e.calendarId, 'cal9');
  assert.equal(e.recurringEventId, 'x');
});
