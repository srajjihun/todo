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
function normalizeEvent(e) {
  const base = { id: e.id, title: e.summary || '(제목 없음)' };
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
function applyEventsDelta(events, items) {
  for (const item of items) {
    if (item.status === 'cancelled') {
      delete events[item.id];
      const prefix = item.id + '_';
      for (const k of Object.keys(events)) {
        if (k.startsWith(prefix)) delete events[k];
      }
    } else {
      events[item.id] = normalizeEvent(item);
    }
  }
  return events;
}

module.exports = {
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
