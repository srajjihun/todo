'use strict';
// 동기화 엔진: Google이 원본(source of truth), 로컬 캐시는 표시/오프라인용.
// 쓰기는 낙관적 반영 후 즉시 API 푸시, 실패/오프라인 시 pending 큐에 보관했다가 재생.
const crypto = require('crypto');
const auth = require('./auth');
const api = require('./google-api');
const logic = require('./sync-logic');

const EVENTS_WINDOW_DAYS = 90;  // 과거 90일부터
const EVENTS_FUTURE_DAYS = 400; // 미래 400일까지 (반복 할 일을 앞당겨 보기 위해)
const RETRY_DELAY_MS = 30000;

let stores = null; // { settings, cache, pending }
let onState = () => {};
let onStatus = () => {};
let syncing = null;
let timer = null;
let retryTimer = null;
let lastStatus = { phase: 'idle', lastSyncAt: null, pendingCount: 0, message: null };

// 직접 경로로 전송 중인 insert: tempId -> Promise<realId|null>
const inFlightInserts = new Map();
// insert가 서버에 도달하기 전에 사용자가 삭제한 임시 id — 완료 시 재추가 방지
const tombstoned = new Set();

function init(s, callbacks) {
  stores = s;
  if (callbacks.onState) onState = callbacks.onState;
  if (callbacks.onStatus) onStatus = callbacks.onStatus;
}

function getState() {
  const cache = stores.cache.data;
  const todoCal = stores.settings.data.todoCalendarId;
  const all = Object.values(cache.events);
  // 전용 할 일 캘린더의 일정은 캘린더 탭에 보이지 않고 할 일 탭으로만 간다
  const calendarEvents = todoCal ? all.filter((e) => e.calendarId !== todoCal) : all;
  const todoEvents = todoCal ? all.filter((e) => e.calendarId === todoCal) : [];
  return {
    events: calendarEvents,
    todoOccurrences: logic.buildTodoOccurrences(todoEvents, cache.todoMasters || {}),
    calendars: cache.calendars || [],
    todoCalendarId: todoCal || null,
    tasks: Object.values(cache.tasks),
    lastSyncAt: cache.lastSyncAt,
    pendingCount: stores.pending.data.ops.length,
    loggedIn: auth.isLoggedIn(),
    pinned: !!stores.settings.data.pinned,
  };
}

function pushState() { onState(getState()); }

function setStatus(partial) {
  lastStatus = {
    ...lastStatus,
    ...partial,
    lastSyncAt: stores.cache.data.lastSyncAt,
    pendingCount: stores.pending.data.ops.length,
  };
  onStatus(lastStatus);
}
function getStatus() { return lastStatus; }

// ---------------- 스케줄러 ----------------
function startScheduler() {
  stopScheduler();
  // 최대 24시간까지 허용 (설정에서 3/6/12시간 선택)
  const min = Math.min(1440, Math.max(1, Number(stores.settings.data.syncIntervalMin) || 180));
  timer = setInterval(() => { syncNow('interval'); }, min * 60 * 1000);
}
function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
// 직접 쓰기 실패로 큐잉된 뒤 잠시 후 재시도
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (auth.isLoggedIn()) syncNow('retry');
  }, RETRY_DELAY_MS);
}

// ---------------- 동기화 본체 ----------------
function syncNow(reason) {
  if (!auth.isLoggedIn()) {
    setStatus({ phase: 'auth-required', message: null });
    return Promise.resolve();
  }
  if (syncing) return syncing;
  syncing = doSync(reason)
    .catch((e) => handleSyncError(e))
    .finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  setStatus({ phase: 'syncing', message: null });
  const warnings = await flushPending();
  await pullCalendars();
  await pullEvents();
  await pullTodoMasters();
  await pullTasks();
  stores.cache.update({ lastSyncAt: new Date().toISOString() });
  pushState();
  setStatus({ phase: 'idle', message: warnings.length ? warnings[0] : null });
}

function handleSyncError(e) {
  if (e instanceof auth.AuthRequiredError) {
    setStatus({ phase: 'auth-required', message: e.message });
  } else if (api.isRetryable(e)) {
    setStatus({ phase: 'offline', message: null });
  } else {
    console.error('[sync] 동기화 오류:', e);
    setStatus({ phase: 'error', message: e.message });
  }
  pushState();
}

// pending 큐 FIFO 재생. 네트워크성 오류면 중단(큐 보존), 영구 4xx면 해당 op만 폐기.
// 실행 도중 큐가 외부에서 걸러질 수 있으므로(임시 항목 삭제) 위치가 아닌 opId로 제거한다.
async function flushPending() {
  const warnings = [];
  const pending = stores.pending.data;
  while (pending.ops.length > 0) {
    const op = pending.ops[0];
    try {
      await executeOp(op);
      removeOpById(op.opId);
    } catch (e) {
      if (api.isRetryable(e) || e instanceof auth.AuthRequiredError) throw e;
      // 영구 실패(400/403/404 등): op 폐기 — 이어지는 pull이 서버 상태로 복원
      console.warn('[sync] 반영 실패로 폐기된 작업:', op.kind, e.message);
      warnings.push('일부 변경사항을 구글에 반영하지 못했습니다.');
      // 낙관적으로 넣어둔 임시 항목도 제거해 유령 항목을 막는다
      if (op.tempId) {
        delete stores.cache.data.events[op.tempId];
        delete stores.cache.data.tasks[op.tempId];
        stores.cache.save();
        pushState();
      }
      removeOpById(op.opId);
    }
  }
  return warnings;
}

function removeOpById(opId) {
  const ops = stores.pending.data.ops;
  const i = ops.findIndex((o) => o.opId === opId);
  if (i !== -1) ops.splice(i, 1);
  stores.pending.save();
}

async function executeOp(op) {
  const cache = stores.cache.data;
  if (op.kind === 'event.insert') {
    const calId = op.calendarId || 'primary';
    const real = await api.insertEvent(calId, op.payload);
    delete cache.events[op.tempId];
    if (tombstoned.has(op.tempId)) {
      // 전송 대기 중 사용자가 삭제함 → 서버에서도 되돌린다
      tombstoned.delete(op.tempId);
      await ignoreGone(api.deleteEvent(calId, real.id));
    } else {
      cache.events[real.id] = logic.normalizeEvent(real, calId);
      logic.remapTempId(stores.pending.data.ops, op.tempId, real.id);
    }
    stores.cache.save();
  } else if (op.kind === 'event.delete') {
    await ignoreGone(api.deleteEvent(op.calendarId || 'primary', op.targetId));
  } else if (op.kind === 'todo.done') {
    // 원장은 통째로 덮어쓰므로, 재생 시점의 서버 상태를 다시 읽어 계산한다
    await pushOccurrenceDone(op.calendarId, op.masterId, op.date, op.done);
  } else if (op.kind === 'task.insert') {
    const real = await api.insertTask(op.listId, op.payload);
    delete cache.tasks[op.tempId];
    if (tombstoned.has(op.tempId)) {
      tombstoned.delete(op.tempId);
      await ignoreGone(api.deleteTask(op.listId, real.id));
    } else {
      cache.tasks[real.id] = logic.normalizeTask(real);
      logic.remapTempId(stores.pending.data.ops, op.tempId, real.id);
    }
    stores.cache.save();
  } else if (op.kind === 'task.patch') {
    if (logic.isTempId(op.targetId)) throw new api.ApiError(400, '임시 항목 패치 폐기'); // insert가 폐기된 경우
    const real = await ignoreGone(api.patchTask(op.listId, op.targetId, op.payload));
    if (real) { cache.tasks[real.id] = logic.normalizeTask(real); stores.cache.save(); }
  } else if (op.kind === 'task.delete') {
    await ignoreGone(api.deleteTask(op.listId, op.targetId));
  }
}

// 이미 서버에서 사라진 대상(404/410)은 성공으로 간주
async function ignoreGone(promise) {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof api.ApiError && (e.status === 404 || e.status === 410)) return null;
    throw e;
  }
}

// ---------------- Pull ----------------
// 동기화 대상 캘린더 = 표시 대상 + 전용 할 일 캘린더
function syncedCalendarIds() {
  const st = stores.settings.data;
  const cache = stores.cache.data;
  const known = (cache.calendars || []).map((c) => c.id);
  let ids = st.visibleCalendarIds && st.visibleCalendarIds.length
    ? st.visibleCalendarIds.filter((id) => known.includes(id))
    : known.slice();
  if (!ids.length) ids = ['primary'];
  if (st.todoCalendarId && !ids.includes(st.todoCalendarId)) ids.push(st.todoCalendarId);
  return ids;
}

async function pullCalendars() {
  const cache = stores.cache.data;
  try {
    const res = await api.listCalendars();
    cache.calendars = (res.items || []).map((c) => ({
      id: c.id,
      title: c.summaryOverride || c.summary || c.id,
      primary: !!c.primary,
    }));
    stores.cache.save();
  } catch (e) {
    // 캘린더 목록 권한이 아직 없으면(재로그인 전) 기본 캘린더만 쓰고 계속 진행
    if (e instanceof api.ApiError && (e.status === 403 || e.status === 401)) {
      if (!(cache.calendars || []).length) {
        cache.calendars = [{ id: 'primary', title: '기본 캘린더', primary: true }];
        stores.cache.save();
      }
      return;
    }
    throw e;
  }
}

async function pullEvents() {
  const cache = stores.cache.data;
  const ids = syncedCalendarIds();
  const seen = {};

  for (const calId of ids) {
    const token = (cache.eventsSyncTokens || {})[calId];
    try {
      if (token) await pullEventsIncremental(calId, seen);
      else await pullEventsFull(calId, seen);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 410) {
        cache.eventsSyncTokens[calId] = null;
        await pullEventsFull(calId, seen);
      } else if (e instanceof api.ApiError && (e.status === 403 || e.status === 404)) {
        // 접근 권한이 사라진 캘린더는 건너뛴다
        console.warn('[sync] 캘린더 건너뜀:', calId, e.message);
      } else {
        throw e;
      }
    }
  }
  stores.cache.save();
}

async function pullEventsFull(calendarId, seen) {
  const cache = stores.cache.data;
  const timeMin = new Date(Date.now() - EVENTS_WINDOW_DAYS * 86400000).toISOString();
  // 반복 할 일을 미래까지 보려면 창을 넉넉히 잡아야 한다 (구글이 그만큼 펼쳐서 준다)
  const timeMax = new Date(Date.now() + EVENTS_FUTURE_DAYS * 86400000).toISOString();
  const server = {};
  let pageToken;
  let syncToken = null;
  do {
    const res = await api.listEvents(calendarId, {
      timeMin, timeMax, singleEvents: 'true', maxResults: 250, pageToken,
    });
    for (const item of res.items || []) {
      if (item.status !== 'cancelled') server[item.id] = logic.normalizeEvent(item, calendarId);
    }
    pageToken = res.nextPageToken;
    if (res.nextSyncToken) syncToken = res.nextSyncToken;
  } while (pageToken);

  // 이 캘린더 몫만 교체하고 다른 캘린더 항목은 보존
  for (const [id, ev] of Object.entries(cache.events)) {
    if (ev.calendarId === calendarId) delete cache.events[id];
  }
  Object.assign(cache.events, server);
  cache.events = logic.applyPendingToEvents(cache.events, cache.events, stores.pending.data.ops);
  cache.eventsSyncTokens[calendarId] = syncToken;
  if (seen) seen[calendarId] = true;
}

async function pullEventsIncremental(calendarId, seen) {
  const cache = stores.cache.data;
  let pageToken;
  let syncToken = cache.eventsSyncTokens[calendarId];
  do {
    // syncToken은 timeMin/timeMax/q/orderBy 등과 함께 쓸 수 없다(400).
    // singleEvents만 초기 동기화와 동일하게 유지해 인스턴스 id 공간을 맞춘다.
    const params = { syncToken: cache.eventsSyncTokens[calendarId], singleEvents: 'true', maxResults: 250 };
    if (pageToken) params.pageToken = pageToken;
    const res = await api.listEvents(calendarId, params);
    logic.applyEventsDelta(cache.events, res.items || [], calendarId);
    pageToken = res.nextPageToken;
    if (res.nextSyncToken) syncToken = res.nextSyncToken;
  } while (pageToken);
  cache.eventsSyncTokens[calendarId] = syncToken;
  if (seen) seen[calendarId] = true;
}

// 전용 할 일 캘린더의 "부모" 일정 = 반복 규칙 + 완료 원장.
// singleEvents/syncToken을 쓰지 않는 별도 호출이라 위의 증분 동기화와 충돌하지 않는다.
async function pullTodoMasters() {
  const cache = stores.cache.data;
  const calId = stores.settings.data.todoCalendarId;
  if (!calId) { cache.todoMasters = {}; return; }
  const server = {};
  let pageToken;
  try {
    do {
      const res = await api.listEvents(calId, { maxResults: 250, showDeleted: 'false', pageToken });
      for (const item of res.items || []) {
        if (item.status === 'cancelled') continue;
        server[item.id] = logic.normalizeTodoMaster(item, calId);
      }
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof api.ApiError && (e.status === 403 || e.status === 404)) return;
    throw e;
  }
  cache.todoMasters = server;
  stores.cache.save();
}

async function pullTasks() {
  const cache = stores.cache.data;
  const listId = currentListId();
  const server = {};
  let pageToken;
  do {
    const res = await api.listTasks(listId, pageToken);
    for (const item of res.items || []) {
      if (item.deleted) continue;
      server[item.id] = logic.normalizeTask(item);
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  cache.tasks = logic.applyPendingToTasks(server, cache.tasks, stores.pending.data.ops);
  stores.cache.save();
}

function currentListId() { return stores.settings.data.taskListId || '@default'; }

// ---------------- 쓰기 경로 ----------------
function newTempId() { return 'local-' + crypto.randomUUID(); }

function queueOp(op) {
  stores.pending.data.ops.push({ opId: crypto.randomUUID(), createdAt: new Date().toISOString(), ...op });
  stores.pending.save();
  setStatus({ phase: auth.isLoggedIn() ? 'offline' : 'auth-required' });
}

// 낙관적 반영 후 즉시 푸시.
// 큐가 비어있지 않거나 / 로그아웃 상태거나 / 동기화가 도는 중이거나 / 대상이 임시 id면
// 순서·일관성 보존을 위해 무조건 큐잉한다.
async function optimisticWrite({ applyLocal, rollback, op, runNow, tempId }) {
  applyLocal();
  stores.cache.save();
  pushState();

  const mustQueue = stores.pending.data.ops.length > 0
    || !auth.isLoggedIn()
    || !!syncing
    || (op.targetId && logic.isTempId(op.targetId));
  if (mustQueue) {
    queueOp(op);
    if (auth.isLoggedIn()) {
      if (syncing) syncing.then(() => syncNow('post-write'));
      else syncNow('post-write');
    }
    return { queued: true };
  }

  let resolveInFlight = null;
  if (tempId) {
    inFlightInserts.set(tempId, new Promise((r) => { resolveInFlight = r; }));
  }
  try {
    const realId = await runNow();
    stores.cache.save();
    pushState();
    setStatus({ phase: 'idle' });
    if (resolveInFlight) resolveInFlight(realId || null);
    return { ok: true };
  } catch (e) {
    if (resolveInFlight) resolveInFlight(null);
    if (api.isRetryable(e) || e instanceof auth.AuthRequiredError) {
      queueOp(op);
      scheduleRetry();
      return { queued: true };
    }
    rollback();
    stores.cache.save();
    pushState();
    throw new Error(`구글에 반영하지 못했습니다: ${e.message}`);
  } finally {
    if (tempId) inFlightInserts.delete(tempId);
  }
}

async function addEvent({ title, date, allDay, startTime, endTime, calendarId }) {
  const cache = stores.cache.data;
  const tempId = newTempId();
  if (!calendarId) calendarId = 'primary';
  let payload;
  let normalized;

  if (allDay) {
    const endDate = logic.addDaysStr(date, 1); // 배타적 종료일
    payload = { summary: title, start: { date }, end: { date: endDate } };
    normalized = { id: tempId, title, allDay: true, startDate: date, startTime: null, endDate, endTime: null };
  } else {
    const start = localDateTime(date, startTime || '09:00');
    let end = localDateTime(date, endTime || startTime || '09:00');
    if (end <= start) end = new Date(start.getTime() + 3600000); // 종료가 빠르면 +1시간
    payload = {
      summary: title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };
    normalized = logic.normalizeEvent({ id: tempId, summary: title, start: payload.start, end: payload.end });
  }

  normalized.calendarId = calendarId;
  return optimisticWrite({
    applyLocal: () => { cache.events[tempId] = normalized; },
    rollback: () => { delete cache.events[tempId]; },
    op: { kind: 'event.insert', payload, tempId, calendarId },
    tempId,
    runNow: async () => {
      const real = await api.insertEvent(calendarId, payload);
      delete cache.events[tempId];
      if (tombstoned.has(tempId)) return real.id; // 삭제 처리는 deleteEvent 쪽에서
      cache.events[real.id] = logic.normalizeEvent(real, calendarId);
      return real.id;
    },
  });
}

async function deleteEvent(eventId) {
  const cache = stores.cache.data;
  if (logic.isTempId(eventId)) return deleteTempEntry({ kind: 'event', id: eventId });
  const prev = cache.events[eventId];
  if (!prev) return { ok: true };
  const calId = prev.calendarId || 'primary';
  return optimisticWrite({
    applyLocal: () => { delete cache.events[eventId]; },
    rollback: () => { cache.events[eventId] = prev; },
    op: { kind: 'event.delete', targetId: eventId, calendarId: calId },
    runNow: () => ignoreGone(api.deleteEvent(calId, eventId)),
  });
}

async function addTask({ title, notes, due }) {
  const cache = stores.cache.data;
  const listId = currentListId();
  const tempId = newTempId();
  const payload = { title };
  if (notes) payload.notes = notes;
  if (due) payload.due = `${due}T00:00:00.000Z`;
  const normalized = {
    id: tempId, title, notes: notes || '', due: due || null,
    status: 'needsAction', position: '', updated: new Date().toISOString(),
  };
  return optimisticWrite({
    applyLocal: () => { cache.tasks[tempId] = normalized; },
    rollback: () => { delete cache.tasks[tempId]; },
    op: { kind: 'task.insert', payload, tempId, listId },
    tempId,
    runNow: async () => {
      const real = await api.insertTask(listId, payload);
      delete cache.tasks[tempId];
      if (tombstoned.has(tempId)) return real.id; // 삭제 처리는 deleteTask 쪽에서
      cache.tasks[real.id] = logic.normalizeTask(real);
      return real.id;
    },
  });
}

async function patchTaskLocal(taskId, patchPayload, patchNorm) {
  // 전송 중인 임시 항목이면 insert 완료를 기다렸다가 실제 id로 다시 시도
  if (logic.isTempId(taskId) && inFlightInserts.has(taskId)) {
    const realId = await inFlightInserts.get(taskId);
    if (realId) return patchTaskLocal(realId, patchPayload, patchNorm);
    // insert가 큐로 넘어감 → 아래 일반 경로가 큐잉 처리
  }
  const cache = stores.cache.data;
  const listId = currentListId();
  const prev = cache.tasks[taskId];
  if (!prev) return { ok: true };
  const next = { ...prev, ...patchNorm, updated: new Date().toISOString() };
  return optimisticWrite({
    applyLocal: () => { cache.tasks[taskId] = next; },
    rollback: () => { cache.tasks[taskId] = prev; },
    op: { kind: 'task.patch', payload: patchPayload, payloadNorm: patchNorm, targetId: taskId, listId },
    runNow: async () => {
      const real = await ignoreGone(api.patchTask(listId, taskId, patchPayload));
      if (real) cache.tasks[real.id] = logic.normalizeTask(real);
    },
  });
}

function setTaskCompleted(taskId, completed) {
  const status = completed ? 'completed' : 'needsAction';
  return patchTaskLocal(taskId, { status }, { status });
}

function postponeTaskToToday(taskId) {
  const today = logic.toLocalDateStr(new Date());
  return patchTaskLocal(taskId, { due: `${today}T00:00:00.000Z` }, { due: today });
}

// 기한 초과 항목 전부 오늘로 연기
async function postponeOverdue() {
  const today = logic.toLocalDateStr(new Date());
  const overdue = Object.values(stores.cache.data.tasks)
    .filter((t) => t.status !== 'completed' && t.due && t.due < today);
  for (const t of overdue) {
    await postponeTaskToToday(t.id);
  }
  return { ok: true, count: overdue.length };
}

async function deleteTask(taskId) {
  const cache = stores.cache.data;
  if (logic.isTempId(taskId)) return deleteTempEntry({ kind: 'task', id: taskId });
  const listId = currentListId();
  const prev = cache.tasks[taskId];
  if (!prev) return { ok: true };
  return optimisticWrite({
    applyLocal: () => { delete cache.tasks[taskId]; },
    rollback: () => { cache.tasks[taskId] = prev; },
    op: { kind: 'task.delete', targetId: taskId, listId },
    runNow: () => ignoreGone(api.deleteTask(listId, taskId)),
  });
}

// 임시 id 삭제 공통 처리:
// - 직접 경로 insert가 전송 중이면 완료를 기다려 실제 id를 서버에서도 삭제
// - 큐에 남아 있으면 큐에서 걸러내고, 이미 실행 중일 수 있으니 tombstone 표시
async function deleteTempEntry({ kind, id }) {
  const cache = stores.cache.data;
  const listId = currentListId();
  const bucket = kind === 'task' ? cache.tasks : cache.events;

  delete bucket[id]; // 즉시 UI에서 제거
  tombstoned.add(id); // 실행 중인 insert가 완료 후 재추가하지 못하게
  stores.cache.save();
  pushState();

  if (inFlightInserts.has(id)) {
    const realId = await inFlightInserts.get(id);
    tombstoned.delete(id);
    if (realId) {
      // 서버에 생성됐으므로 서버에서도 삭제
      if (kind === 'task') {
        return optimisticWrite({
          applyLocal: () => { delete cache.tasks[realId]; },
          rollback: () => {},
          op: { kind: 'task.delete', targetId: realId, listId },
          runNow: () => ignoreGone(api.deleteTask(listId, realId)),
        });
      }
      return optimisticWrite({
        applyLocal: () => { delete cache.events[realId]; },
        rollback: () => {},
        op: { kind: 'event.delete', targetId: realId, calendarId: 'primary' },
        runNow: () => ignoreGone(api.deleteEvent('primary', realId)),
      });
    }
  }

  // 큐에서 이 임시 항목 관련 op 제거 (insert + 그 위의 patch/delete)
  const insertKind = kind === 'task' ? 'task.insert' : 'event.insert';
  stores.pending.data.ops = stores.pending.data.ops.filter(
    (op) => !((op.kind === insertKind && op.tempId === id) || op.targetId === id)
  );
  stores.pending.save();
  pushState();
  return { ok: true };
}

// ---- 반복 할 일 (전용 캘린더의 반복 일정) ----
const RRULES = {
  daily: 'RRULE:FREQ=DAILY',
  weekdays: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  every2days: 'RRULE:FREQ=DAILY;INTERVAL=2',
  weekly: 'RRULE:FREQ=WEEKLY',
  monthly: 'RRULE:FREQ=MONTHLY',
};

// repeat: 'daily' | 'weekdays' | 'every2days' | 'weekly' | 'monthly' | 'none'
// byday: ['MO','WE'] 처럼 요일 지정 시 weekly에 덧붙인다
async function addRecurringTodo({ title, startDate, repeat, byday }) {
  const calendarId = stores.settings.data.todoCalendarId;
  if (!calendarId) throw new Error('설정에서 할 일 캘린더를 먼저 선택해주세요.');
  const date = startDate || logic.toLocalDateStr(new Date());

  let rrule = RRULES[repeat] || null;
  if (repeat === 'weekly' && byday && byday.length) {
    rrule = 'RRULE:FREQ=WEEKLY;BYDAY=' + byday.join(',');
  }

  const payload = {
    summary: title,
    start: { date },
    end: { date: logic.addDaysStr(date, 1) },
    transparency: 'transparent', // 캘린더에서 '바쁨'으로 잡히지 않게
  };
  if (rrule) payload.recurrence = [rrule];

  const real = await api.insertEvent(calendarId, payload);
  await syncNow('after-add-todo');
  return { ok: true, id: real.id };
}

// 완료 원장을 서버에 반영 (If-Match 낙관적 잠금 + 412 재시도)
async function pushOccurrenceDone(calendarId, masterId, dateStr, done, attempt = 0) {
  const cache = stores.cache.data;
  let master = cache.todoMasters[masterId];
  if (!master) {
    const fresh = await api.getEvent(calendarId, masterId);
    master = logic.normalizeTodoMaster(fresh, calendarId);
    cache.todoMasters[masterId] = master;
  }
  const { month, value } = logic.ledgerSet(master.ledger, dateStr, done);
  try {
    const real = await api.patchEvent(calendarId, masterId,
      { extendedProperties: { private: { ['done_' + month]: value } } }, master.etag);
    if (real) cache.todoMasters[masterId] = logic.normalizeTodoMaster(real, calendarId);
    stores.cache.save();
  } catch (e) {
    // 412 = 다른 기기가 먼저 고침 → 최신 상태를 다시 읽어 이번 변경만 재적용
    if (e instanceof api.ApiError && e.status === 412 && attempt < 3) {
      const fresh = await api.getEvent(calendarId, masterId);
      cache.todoMasters[masterId] = logic.normalizeTodoMaster(fresh, calendarId);
      return pushOccurrenceDone(calendarId, masterId, dateStr, done, attempt + 1);
    }
    throw e;
  }
}

async function setOccurrenceDone(masterId, dateStr, done) {
  const cache = stores.cache.data;
  const master = cache.todoMasters[masterId];
  if (!master) return { ok: false };
  const calendarId = master.calendarId;

  // 낙관적 반영
  const { month, days } = logic.ledgerSet(master.ledger, dateStr, done);
  const prevLedger = master.ledger;
  master.ledger = { ...master.ledger };
  if (days.length) master.ledger[month] = days;
  else delete master.ledger[month];
  stores.cache.save();
  pushState();

  if (!auth.isLoggedIn() || stores.pending.data.ops.length > 0 || syncing) {
    queueOp({ kind: 'todo.done', calendarId, masterId, date: dateStr, done });
    if (auth.isLoggedIn()) syncNow('post-write');
    return { queued: true };
  }
  try {
    await pushOccurrenceDone(calendarId, masterId, dateStr, done);
    pushState();
    setStatus({ phase: 'idle' });
    return { ok: true };
  } catch (e) {
    if (api.isRetryable(e) || e instanceof auth.AuthRequiredError) {
      queueOp({ kind: 'todo.done', calendarId, masterId, date: dateStr, done });
      scheduleRetry();
      return { queued: true };
    }
    master.ledger = prevLedger; // 영구 실패 → 되돌리기
    stores.cache.save();
    pushState();
    throw new Error('구글에 반영하지 못했습니다: ' + e.message);
  }
}

// 반복 할 일 전체 삭제 (부모 일정 삭제 → 모든 발생분 사라짐)
async function deleteRecurringTodo(masterId) {
  const cache = stores.cache.data;
  const master = cache.todoMasters[masterId];
  if (!master) return { ok: true };
  delete cache.todoMasters[masterId];
  for (const [id, ev] of Object.entries(cache.events)) {
    if (ev.id === masterId || ev.recurringEventId === masterId) delete cache.events[id];
  }
  stores.cache.save();
  pushState();
  await ignoreGone(api.deleteEvent(master.calendarId, masterId));
  return { ok: true };
}

// 할 일 캘린더가 바뀌면 관련 캐시를 새로 만든다
function onTodoCalendarChanged() {
  stores.cache.data.todoMasters = {};
  stores.cache.save();
  pushState();
  return syncNow('todo-calendar-changed');
}

function localDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
}

// 할 일 목록 변경 시: 다른 목록의 캐시는 무의미하므로 tasks 캐시 재구축
function onTaskListChanged() {
  stores.cache.data.tasks = {};
  stores.cache.save();
  pushState();
  return syncNow('list-changed');
}

module.exports = {
  init,
  getState,
  getStatus,
  pushState,
  setStatus,
  syncNow,
  startScheduler,
  stopScheduler,
  addEvent,
  deleteEvent,
  addTask,
  setTaskCompleted,
  deleteTask,
  postponeOverdue,
  onTaskListChanged,
  addRecurringTodo,
  setOccurrenceDone,
  deleteRecurringTodo,
  onTodoCalendarChanged,
};
