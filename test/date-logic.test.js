'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/renderer/date-logic');

test('buildMonthGrid: 2026년 8월은 7/26(일)부터 42칸', () => {
  const cells = D.buildMonthGrid(2026, 7); // 8월 (0-based)
  assert.equal(cells.length, 42);
  assert.equal(cells[0].dateStr, '2026-07-26');
  assert.equal(cells[0].otherMonth, true);
  assert.equal(cells[6].dateStr, '2026-08-01');
  assert.equal(cells[6].otherMonth, false);
  // 스크린샷과 동일: 마지막 주에 9/1~9/5 포함
  assert.equal(cells[41].dateStr, '2026-09-05');
});

test('formatKoreanDate / monthTitle', () => {
  assert.equal(D.formatKoreanDate('2026-08-28'), '8월 28일 금요일');
  assert.equal(D.monthTitle(2026, 7), '2026년 8월');
});

test('bucketEventsByDay: 종일 다일 이벤트는 각 날짜에, 배타적 종료일 제외', () => {
  const map = D.bucketEventsByDay([
    { id: 'a', title: '여행', allDay: true, startDate: '2026-08-28', endDate: '2026-08-30' },
    { id: 'b', title: '회의', allDay: false, startDate: '2026-08-28', startTime: '10:00' },
  ]);
  assert.equal(map['2026-08-28'].length, 2);
  assert.equal(map['2026-08-29'].length, 1);
  assert.equal(map['2026-08-30'], undefined);
  // 종일이 먼저
  assert.equal(map['2026-08-28'][0].id, 'a');
});

test('groupTasks: 마감일 기준 그룹', () => {
  const g = D.groupTasks([
    { id: '1', title: '지난 것', due: '2026-08-27', status: 'needsAction' },
    { id: '2', title: '오늘 것', due: '2026-08-28', status: 'needsAction' },
    { id: '3', title: '내일 것', due: '2026-08-29', status: 'needsAction' },
    { id: '4', title: '기한 없음', due: null, status: 'needsAction' },
    { id: '5', title: '끝난 것', due: '2026-08-20', status: 'completed' },
  ], '2026-08-28');
  assert.deepEqual(g.overdue.map((t) => t.id), ['1']);
  assert.deepEqual(g.today.map((t) => t.id), ['2']);
  assert.deepEqual(g.upcoming.map((t) => t.id), ['3']);
  assert.deepEqual(g.someday.map((t) => t.id), ['4']);
  assert.deepEqual(g.completed.map((t) => t.id), ['5']);
});

test('dueLabel', () => {
  const today = '2026-08-28';
  assert.deepEqual(D.dueLabel('2026-08-27', today), { text: '어제', cls: 'overdue' });
  assert.deepEqual(D.dueLabel('2026-08-25', today), { text: '3일 전', cls: 'overdue' });
  assert.deepEqual(D.dueLabel('2026-08-28', today), { text: '오늘', cls: 'today' });
  assert.deepEqual(D.dueLabel('2026-08-29', today), { text: '내일', cls: 'future' });
  assert.deepEqual(D.dueLabel('2026-09-02', today), { text: '5일 후', cls: 'future' });
  assert.deepEqual(D.dueLabel('2026-10-01', today), { text: '10월 1일', cls: 'future' });
  assert.equal(D.dueLabel(null, today), null);
});

test('formatTimer', () => {
  assert.equal(D.formatTimer(25 * 60 * 1000), '25:00');
  assert.equal(D.formatTimer(61_500), '01:02'); // 올림
  assert.equal(D.formatTimer(0), '00:00');
  assert.equal(D.formatTimer(-5), '00:00');
});

test('diffDays / addDays', () => {
  assert.equal(D.diffDays('2026-09-01', '2026-08-28'), 4);
  assert.equal(D.addDays('2026-08-31', 1), '2026-09-01');
});

test('weekOf: 일요일 시작 7일, 월 경계를 넘어도 이어진다', () => {
  const w = D.weekOf('2026-09-01'); // 화요일
  assert.equal(w.length, 7);
  assert.equal(w[0], '2026-08-30'); // 일요일
  assert.equal(w[6], '2026-09-05'); // 토요일
  assert.ok(w.includes('2026-09-01'));
});

test('weekOf: 일요일을 주면 그 날이 첫날', () => {
  assert.equal(D.weekOf('2026-08-30')[0], '2026-08-30');
});

test('weekTitle', () => {
  assert.equal(D.weekTitle(D.weekOf('2026-09-01')), '8월 30일 – 9월 5일');
});
