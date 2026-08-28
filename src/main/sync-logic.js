'use strict';
// 동기화 순수 로직 (Electron 의존 없음 — node:test로 단위 테스트 가능)

function pad2(n) { return String(n).padStart(2, '0'); }
function toLocalDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toLocalTimeStr(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return toLocalDateStr(dt);
}

function isTempId(id) { return typeof id === 'string' && id.startsWith('local-'); }

// Google Calendar 이벤트 → 위젯 내부 표현
function normalizeEvent(e, calendarId) {
  const base = {
    id: e.id,
    title: e.summary || '(제목 없음)',
    calendarId: calendarId || e.calendarId || 'primary',
    // 반복 일정의 인스턴스면 부모(마스터) id — 할 일 조인에 쓰인다
    recurringEventId: e.recurringEventId || null,
  };
  if (e.start && e.start.date) {
    return {
      ...base,
      allDay: true,
      startDate: e.start.date,
      startTime: null,
      // Google 종일 이벤트의 end.date는 배타적(exclusive)
      endDate: (e.end && e.end.date) || addDaysStr(e.start.date, 1),
      endTime: null,
    };
  }
  const s = new Date(e.start && e.start.dateTime ? e.start.dateTime : Date.now());
  const en = new Date(e.end && e.end.dateTime ? e.end.dateTime : s.getTime());
  return {
    ...base,
    allDay: false,
    startDate: toLocalDateStr(s),
    startTime: toLocalTimeStr(s),
    endDate: toLocalDateStr(en),
    endTime: toLocalTimeStr(en),
  };
}

// Google Tasks 항목 → 위젯 내부 표현 (due는 날짜만 의미 있음)
function normalizeTask(t) {
  return {
    id: t.id,
    title: t.title || '',
    notes: t.notes || '',
    due: t.due ? t.due.slice(0, 10) : null,
    status: t.status === 'completed' ? 'completed' : 'needsAction',
    position: t.position || '',
    updated: t.updated || null,
  };
}

// insert 성공 후: 이후 큐에 남은 op들의 targetId를 실제 id로 재매핑
function remapTempId(ops, tempId, realId) {
  for (const op of ops) {
    if (op.targetId === tempId) op.targetId = realId;
  }
  return ops;
}

// 서버 전체 pull 결과 위에, 아직 전송 못 한 pending op들을 다시 적용
// (오프라인에서 만든 항목이 pull로 사라지지 않게)
function applyPendingToTasks(serverTasks, localTasks, ops) {
  const out = { ...serverTasks };
  for (const op of ops) {
    if (op.kind === 'task.insert') {
      if (localTasks[op.tempId]) out[op.tempId] = localTasks[op.tempId];
    } else if (op.kind === 'task.patch') {
      if (out[op.targetId]) out[op.targetId] = { ...out[op.targetId], ...op.payloadNorm };
    } else if (op.kind === 'task.delete') {
      delete out[op.targetId];
    }
  }
  return out;
}

function applyPendingToEvents(serverEvents, localEvents, ops) {
  const out = { ...serverEvents };
  for (const op of ops) {
    if (op.kind === 'event.insert') {
      if (localEvents[op.tempId]) out[op.tempId] = localEvents[op.tempId];
    } else if (op.kind === 'event.delete') {
      delete out[op.targetId];
    }
  }
  return out;
}

// 증분(pull) 델타 적용: status=cancelled → 삭제, 그 외 upsert.
// 캐시는 singleEvents 확장 인스턴스 id('마스터id_20260901T…')로 키가 잡혀 있는데,
// 반복 일정 전체 삭제 시 델타에는 확장되지 않은 마스터 id가 오므로 접두사 일치로도 지운다.
function applyEventsDelta(events, items, calendarId) {
  for (const item of items) {
    if (item.status === 'cancelled') {
      delete events[item.id];
      const prefix = item.id + '_';
      for (const k of Object.keys(events)) {
        if (k.startsWith(prefix)) delete events[k];
      }
    } else {
      events[item.id] = normalizeEvent(item, calendarId);
    }
  }
  return events;
}

// ---- 반복 할 일: 완료 원장 ----
// 구글 일정의 extendedProperties.private 에 done_YYYY-MM = "1,3,5" 형태로 저장한다.
// 인스턴스마다 수정하면 반복 예외가 잔뜩 생기므로, 부모 일정 하나에 월별로 모아 둔다.
function parseLedger(priv) {
  const out = {};
  for (const [k, v] of Object.entries(priv || {})) {
    const m = /^done_(\d{4}-\d{2})$/.exec(k);
    if (!m) continue;
    const days = String(v || '').split(',')
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
    if (days.length) out[m[1]] = days.sort((a, b) => a - b);
  }
  return out;
}

// 원장에서 특정 날짜의 완료 여부
function ledgerHas(ledger, dateStr) {
  const month = dateStr.slice(0, 7);
  const day = parseInt(dateStr.slice(8, 10), 10);
  return !!(ledger && ledger[month] && ledger[month].includes(day));
}

// 원장에 날짜 추가/제거 → 그 달의 새 값 (빈 달은 null = 키 삭제)
function ledgerSet(ledger, dateStr, done) {
  const month = dateStr.slice(0, 7);
  const day = parseInt(dateStr.slice(8, 10), 10);
  const cur = new Set((ledger && ledger[month]) || []);
  if (done) cur.add(day);
  else cur.delete(day);
  const days = [...cur].sort((a, b) => a - b);
  return { month, days, value: days.length ? days.join(',') : null };
}

// 반복 할 일 마스터(부모 일정) 정규화
function normalizeTodoMaster(e, calendarId) {
  return {
    id: e.id,
    calendarId: calendarId || 'primary',
    title: e.summary || '(제목 없음)',
    recurrence: e.recurrence || null,
    etag: e.etag || null,
    ledger: parseLedger(e.extendedProperties && e.extendedProperties.private),
  };
}

// 펼쳐진 인스턴스 + 마스터를 조인해 할 일 탭에 그릴 항목 만들기
function buildTodoOccurrences(events, todoMasters) {
  const out = [];
  for (const ev of events) {
    const masterId = ev.recurringEventId || ev.id;
    const master = todoMasters[masterId];
    if (!master) continue;
    out.push({
      kind: 'occ',
      id: ev.id,
      masterId,
      calendarId: master.calendarId,
      title: ev.title,
      due: ev.startDate,
      status: ledgerHas(master.ledger, ev.startDate) ? 'completed' : 'needsAction',
      repeating: !!master.recurrence,
      position: ev.startTime || '',
    });
  }
  return out;
}

module.exports = {
  parseLedger,
  ledgerHas,
  ledgerSet,
  normalizeTodoMaster,
  buildTodoOccurrences,
  isTempId,
  normalizeEvent,
  normalizeTask,
  remapTempId,
  applyPendingToTasks,
  applyPendingToEvents,
  applyEventsDelta,
  toLocalDateStr,
  addDaysStr,
};
