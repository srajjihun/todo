'use strict';
// 동기화 엔진: Google이 원본(source of truth), 로컬 캐시는 표시/오프라인용.
// 쓰기는 낙관적 반영 후 즉시 API 푸시, 실패/오프라인 시 pending 큐에 보관했다가 재생.
const crypto = require('crypto');
const auth = require('./auth');
const api = require('./google-api');
const logic = require('./sync-logic');

const EVENTS_WINDOW_DAYS = 90; // 초기 동기화 시 과거 90일부터
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
  return {
    events: Object.values(cache.events),
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
  const min = Math.min(60, Math.max(1, Number(stores.settings.data.syncIntervalMin) || 5));
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
  await pullEvents();
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
    const real = await api.insertEvent(op.payload);
    delete cache.events[op.tempId];
    if (tombstoned.has(op.tempId)) {
      // 전송 대기 중 사용자가 삭제함 → 서버에서도 되돌린다
      tombstoned.delete(op.tempId);
      await ignoreGone(api.deleteEvent(real.id));
    } else {
      cache.events[real.id] = logic.normalizeEvent(real);
      logic.remapTempId(stores.pending.data.ops, op.tempId, real.id);
    }
    stores.cache.save();
  } else if (op.kind === 'event.delete') {
    await ignoreGone(api.deleteEvent(op.targetId));
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
async function pullEvents() {
  const cache = stores.cache.data;
  try {
    if (cache.eventsSyncToken) await pullEventsIncremental();
    else await pullEventsFull();
  } catch (e) {
    if (e instanceof api.ApiError && e.status === 410) {
      // syncToken 만료 → 전체 재동기화
      cache.eventsSyncToken = null;
      await pullEventsFull();
    } else {
      throw e;
    }
  }
  stores.cache.save();
}

async function pullEventsFull() {
  const cache = stores.cache.data;
  const timeMin = new Date(Date.now() - EVENTS_WINDOW_DAYS * 86400000).toISOString();
  const server = {};
  let pageToken;
  let syncToken = null;
  do {
    const res = await api.listEvents({ timeMin, singleEvents: 'true', maxResults: 250, pageToken });
    for (const item of res.items || []) {
      if (item.status !== 'cancelled') server[item.id] = logic.normalizeEvent(item);
    }
    pageToken = res.nextPageToken;
    if (res.nextSyncToken) syncToken = res.nextSyncToken; // 마지막 페이지에만 존재
  } while (pageToken);
  cache.events = logic.applyPendingToEvents(server, cache.events, stores.pending.data.ops);
  cache.eventsSyncToken = syncToken;
}

async function pullEventsIncremental() {
  const cache = stores.cache.data;
  let pageToken;
  let syncToken = cache.eventsSyncToken;
  do {
    // syncToken은 timeMin/timeMax/q/orderBy 등의 필터와 함께 쓸 수 없지만(400),
    // singleEvents는 초기 전체 동기화와 동일하게 유지해야 확장된 인스턴스 id 공간이 일치한다
    const params = { syncToken: cache.eventsSyncToken, singleEvents: 'true', maxResults: 250 };
    if (pageToken) params.pageToken = pageToken;
    const res = await api.listEvents(params);
    logic.applyEventsDelta(cache.events, res.items || []);
    pageToken = res.nextPageToken;
    if (res.nextSyncToken) syncToken = res.nextSyncToken;
  } while (pageToken);
  cache.eventsSyncToken = syncToken;
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

async function addEvent({ title, date, allDay, startTime, endTime }) {
  const cache = stores.cache.data;
  const tempId = newTempId();
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

  return optimisticWrite({
    applyLocal: () => { cache.events[tempId] = normalized; },
    rollback: () => { delete cache.events[tempId]; },
    op: { kind: 'event.insert', payload, tempId },
    tempId,
    runNow: async () => {
      const real = await api.insertEvent(payload);
      delete cache.events[tempId];
      if (tombstoned.has(tempId)) return real.id; // 삭제 처리는 deleteEvent 쪽에서
      cache.events[real.id] = logic.normalizeEvent(real);
      return real.id;
    },
  });
}

async function deleteEvent(eventId) {
  const cache = stores.cache.data;
  if (logic.isTempId(eventId)) return deleteTempEntry({ kind: 'event', id: eventId });
  const prev = cache.events[eventId];
  if (!prev) return { ok: true };
  return optimisticWrite({
    applyLocal: () => { delete cache.events[eventId]; },
    rollback: () => { cache.events[eventId] = prev; },
    op: { kind: 'event.delete', targetId: eventId },
    runNow: () => ignoreGone(api.deleteEvent(eventId)),
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
        op: { kind: 'event.delete', targetId: realId },
        runNow: () => ignoreGone(api.deleteEvent(realId)),
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
};
