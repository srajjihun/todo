'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../src/main/sync-logic');

test('normalizeEvent: 종일 이벤트', () => {
  const ev = logic.normalizeEvent({
    id: 'e1',
    summary: '휴가',
    start: { date: '2026-08-28' },
    end: { date: '2026-08-30' },
  });
  assert.deepEqual(ev, {
    id: 'e1', title: '휴가', calendarId: 'primary', recurringEventId: null, allDay: true,
    startDate: '2026-08-28', startTime: null,
    endDate: '2026-08-30', endTime: null,
  });
});

test('normalizeEvent: 시간 이벤트는 로컬 날짜/시간으로', () => {
  // 로컬 시간대 무관하게 통과하도록 로컬 Date로 입력을 만든다
  const start = new Date(2026, 7, 28, 10, 0);
  const end = new Date(2026, 7, 28, 11, 30);
  const ev = logic.normalizeEvent({
    id: 'e2', summary: '회의',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  });
  assert.equal(ev.allDay, false);
  assert.equal(ev.startDate, '2026-08-28');
  assert.equal(ev.startTime, '10:00');
  assert.equal(ev.endTime, '11:30');
});

test('normalizeEvent: 제목 없으면 기본 제목', () => {
  const ev = logic.normalizeEvent({ id: 'e3', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } });
  assert.equal(ev.title, '(제목 없음)');
});

test('normalizeTask: due는 날짜만 남김', () => {
  const t = logic.normalizeTask({
    id: 't1', title: '보고서', due: '2026-08-28T00:00:00.000Z', status: 'needsAction', position: '000001',
  });
  assert.equal(t.due, '2026-08-28');
  assert.equal(t.status, 'needsAction');
});

test('remapTempId: 큐에 남은 op들의 targetId 교체', () => {
  const ops = [
    { kind: 'task.patch', targetId: 'local-abc', payload: { status: 'completed' } },
    { kind: 'task.delete', targetId: 'other' },
  ];
  logic.remapTempId(ops, 'local-abc', 'real-1');
  assert.equal(ops[0].targetId, 'real-1');
  assert.equal(ops[1].targetId, 'other');
});

test('applyPendingToTasks: 오프라인 생성 항목이 pull 후에도 유지', () => {
  const server = { s1: { id: 's1', title: '서버 할 일' } };
  const local = { 'local-1': { id: 'local-1', title: '오프라인 할 일' } };
  const ops = [{ kind: 'task.insert', tempId: 'local-1' }];
  const out = logic.applyPendingToTasks(server, local, ops);
  assert.ok(out['local-1']);
  assert.ok(out.s1);
});

test('applyPendingToTasks: 미전송 patch/delete가 서버 상태를 덮음', () => {
  const server = {
    a: { id: 'a', title: 'A', status: 'needsAction' },
    b: { id: 'b', title: 'B' },
  };
  const ops = [
    { kind: 'task.patch', targetId: 'a', payloadNorm: { status: 'completed' } },
    { kind: 'task.delete', targetId: 'b' },
  ];
  const out = logic.applyPendingToTasks(server, {}, ops);
  assert.equal(out.a.status, 'completed');
  assert.equal(out.b, undefined);
});

test('applyPendingToEvents: 임시 이벤트 유지 + 삭제 반영', () => {
  const server = { e1: { id: 'e1' }, e2: { id: 'e2' } };
  const local = { 'local-9': { id: 'local-9', title: '임시' } };
  const ops = [
    { kind: 'event.insert', tempId: 'local-9' },
    { kind: 'event.delete', targetId: 'e2' },
  ];
  const out = logic.applyPendingToEvents(server, local, ops);
  assert.ok(out['local-9']);
  assert.ok(out.e1);
  assert.equal(out.e2, undefined);
});

test('applyEventsDelta: cancelled → 삭제, 그 외 upsert', () => {
  const events = { e1: { id: 'e1', title: '이전' } };
  logic.applyEventsDelta(events, [
    { id: 'e1', status: 'cancelled' },
    { id: 'e2', summary: '새 일정', start: { date: '2026-08-28' }, end: { date: '2026-08-29' } },
  ]);
  assert.equal(events.e1, undefined);
  assert.equal(events.e2.title, '새 일정');
});

test('applyEventsDelta: 반복 일정 마스터 취소 → 확장 인스턴스까지 삭제', () => {
  const events = {
    'master1_20260901T000000Z': { id: 'master1_20260901T000000Z' },
    'master1_20260908T000000Z': { id: 'master1_20260908T000000Z' },
    'master10': { id: 'master10' }, // 접두사가 비슷해도 '_' 경계가 달라 남아야 함
    other: { id: 'other' },
  };
  logic.applyEventsDelta(events, [{ id: 'master1', status: 'cancelled' }]);
  assert.equal(events['master1_20260901T000000Z'], undefined);
  assert.equal(events['master1_20260908T000000Z'], undefined);
  assert.ok(events.master10);
  assert.ok(events.other);
});

test('isTempId', () => {
  assert.ok(logic.isTempId('local-123'));
  assert.ok(!logic.isTempId('abc'));
});
