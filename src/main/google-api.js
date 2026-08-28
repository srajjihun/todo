'use strict';
// Google Calendar / Tasks REST 래퍼 (Node 내장 fetch 사용)
const auth = require('./auth');

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

class ApiError extends Error {
  constructor(status, message, reason) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason || null;
  }
}

// 네트워크 단절/서버 오류/쿼터 → 나중에 재시도 가능
function isRetryable(e) {
  if (e instanceof auth.AuthRequiredError) return false;
  if (e instanceof ApiError) {
    if (e.status >= 500 || e.status === 429 || e.status === 408) return true;
    // 구글은 레이트리밋/쿼터 초과를 403으로도 반환한다 — 영구 실패로 오인해 폐기하면 안 됨
    if (e.status === 403 && /rate|quota/i.test(`${e.reason || ''} ${e.message}`)) return true;
    return false;
  }
  return true; // fetch TypeError(오프라인), 소켓 오류 등
}

async function apiFetch(url, { method = 'GET', body, retryOn401 = true, headers: extra } = {}) {
  const token = await auth.getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, ...(extra || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retryOn401) {
    auth.invalidateAccessToken();
    return apiFetch(url, { method, body, retryOn401: false, headers: extra });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* JSON 아님 */ }
  if (!res.ok) {
    const err = data && data.error;
    const reason = (err && err.errors && err.errors[0] && err.errors[0].reason) || (err && err.status);
    throw new ApiError(res.status, (err && err.message) || res.statusText, reason);
  }
  return data;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---- Calendar ----
// 사용자의 캘린더 목록 (공휴일 등 구독 캘린더 포함)
function listCalendars() {
  return apiFetch(`${CAL_BASE}/users/me/calendarList${qs({ maxResults: 250, minAccessRole: 'reader' })}`);
}

const cal = (id) => encodeURIComponent(id || 'primary');

function listEvents(calendarId, params) {
  return apiFetch(`${CAL_BASE}/calendars/${cal(calendarId)}/events${qs(params)}`);
}
function insertEvent(calendarId, body) {
  return apiFetch(`${CAL_BASE}/calendars/${cal(calendarId)}/events`, { method: 'POST', body });
}
function deleteEvent(calendarId, eventId) {
  return apiFetch(`${CAL_BASE}/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' });
}
// etag를 주면 If-Match로 낙관적 잠금 (동시 수정 시 412)
function patchEvent(calendarId, eventId, body, etag) {
  return apiFetch(`${CAL_BASE}/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body, headers: etag ? { 'If-Match': etag } : undefined });
}
// 일정을 다른 캘린더로 옮긴다 (반복 일정은 부모를 옮기면 시리즈 전체가 이동)
function moveEvent(calendarId, eventId, destination) {
  return apiFetch(`${CAL_BASE}/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}/move`
    + qs({ destination }), { method: 'POST' });
}
function getEvent(calendarId, eventId) {
  return apiFetch(`${CAL_BASE}/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
}

// ---- Tasks ----
function listTaskLists() {
  return apiFetch(`${TASKS_BASE}/users/@me/lists${qs({ maxResults: 100 })}`);
}
function listTasks(taskListId, pageToken) {
  return apiFetch(`${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks${qs({
    showCompleted: 'true',
    showHidden: 'true',
    maxResults: 100,
    pageToken,
  })}`);
}
function insertTask(taskListId, body) {
  return apiFetch(`${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`, { method: 'POST', body });
}
function patchTask(taskListId, taskId, body) {
  return apiFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'PATCH', body }
  );
}
function deleteTask(taskListId, taskId) {
  return apiFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' }
  );
}

module.exports = {
  ApiError,
  isRetryable,
  listCalendars,
  listEvents,
  insertEvent,
  deleteEvent,
  patchEvent,
  getEvent,
  moveEvent,
  listTaskLists,
  listTasks,
  insertTask,
  patchTask,
  deleteTask,
};
