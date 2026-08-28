// 날짜/그룹화 순수 로직 — 렌더러(전역 DateLogic)와 node:test 양쪽에서 사용 (UMD)
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DateLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function todayStr() { return toDateStr(new Date()); }
  function parseDateStr(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(dateStr, n) {
    const d = parseDateStr(dateStr);
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }
  function diffDays(a, b) { // a - b (일 단위)
    return Math.round((parseDateStr(a) - parseDateStr(b)) / 86400000);
  }

  // '2026-08-28' → '8월 28일 금요일'
  function formatKoreanDate(dateStr) {
    const d = parseDateStr(dateStr);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
  }
  // '2026년 8월'
  function monthTitle(year, month /* 0-based */) {
    return `${year}년 ${month + 1}월`;
  }
  // '8월 28일'
  function formatShortDate(dateStr) {
    const d = parseDateStr(dateStr);
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  // 월 그리드: 해당 월 1일이 포함된 주의 일요일부터 6주(42칸)
  function buildMonthGrid(year, month /* 0-based */) {
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push({
        dateStr: toDateStr(d),
        day: d.getDate(),
        otherMonth: d.getMonth() !== month,
      });
    }
    return cells;
  }

  // 이벤트를 날짜별로 버킷팅. 종일 다일(多日) 이벤트는 [startDate, endDate) 각 날짜에 표시.
  function bucketEventsByDay(events) {
    const map = {};
    for (const ev of events) {
      if (ev.allDay) {
        let d = ev.startDate;
        let guard = 0;
        while (d < ev.endDate && guard < 60) { // 60일 초과 이벤트는 잘라서 표시
          (map[d] = map[d] || []).push(ev);
          d = addDays(d, 1);
          guard++;
        }
        if (guard === 0) (map[ev.startDate] = map[ev.startDate] || []).push(ev);
      } else {
        (map[ev.startDate] = map[ev.startDate] || []).push(ev);
      }
    }
    for (const k of Object.keys(map)) map[k] = sortDayEvents(map[k]);
    return map;
  }

  // 종일 먼저, 그다음 시작 시간순
  function sortDayEvents(list) {
    return list.slice().sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return (a.startTime || '').localeCompare(b.startTime || '') || a.title.localeCompare(b.title);
    });
  }

  // 할 일 그룹: 기한 초과 / 오늘 / 예정 / 마감일 없음 / 완료
  function groupTasks(tasks, today) {
    const g = { overdue: [], today: [], upcoming: [], someday: [], completed: [] };
    for (const t of tasks) {
      if (t.status === 'completed') { g.completed.push(t); continue; }
      if (!t.due) { g.someday.push(t); continue; }
      if (t.due < today) g.overdue.push(t);
      else if (t.due === today) g.today.push(t);
      else g.upcoming.push(t);
    }
    const byDue = (a, b) => (a.due || '').localeCompare(b.due || '') || (a.position || '').localeCompare(b.position || '');
    g.overdue.sort(byDue);
    g.today.sort((a, b) => (a.position || '').localeCompare(b.position || ''));
    g.upcoming.sort(byDue);
    g.someday.sort((a, b) => (a.position || '').localeCompare(b.position || ''));
    g.completed.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    return g;
  }

  // 마감일 라벨: {text, cls: 'overdue'|'today'|'future'}
  function dueLabel(due, today) {
    if (!due) return null;
    const diff = diffDays(due, today);
    if (diff < 0) {
      const text = diff === -1 ? '어제' : `${-diff}일 전`;
      return { text, cls: 'overdue' };
    }
    if (diff === 0) return { text: '오늘', cls: 'today' };
    if (diff === 1) return { text: '내일', cls: 'future' };
    if (diff <= 7) return { text: `${diff}일 후`, cls: 'future' };
    return { text: formatShortDate(due), cls: 'future' };
  }

  // 남은 밀리초 → 'MM:SS'
  function formatTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  return {
    WEEKDAYS,
    toDateStr,
    todayStr,
    parseDateStr,
    addDays,
    diffDays,
    formatKoreanDate,
    formatShortDate,
    monthTitle,
    buildMonthGrid,
    bucketEventsByDay,
    sortDayEvents,
    groupTasks,
    dueLabel,
    formatTimer,
  };
});
