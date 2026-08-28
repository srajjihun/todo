'use strict';
// Google Calendar / Tasks REST 래퍼 (Node 내장 fetch 사용)
const auth = require('./auth');

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

// 네트워크 단절/서버 오류/쿼터 → 나중에 재시도 가능
function isRetryable(e) {
  if (e instanceof auth.AuthRequiredError) return false;
  if (e instanceof ApiError) return e.status >= 500 || e.status === 429 || e.status === 408;
  return true; // fetch TypeError(오프라인), 소켓 오류 등
}

async function apiFetch(url, { method = 'GET', body, retryOn401 = true } = {}) {
  const token = await auth.getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retryOn401) {
    auth.invalidateAccessToken();
    return apiFetch(url, { method, body, retryOn401: false });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* JSON 아님 */ }
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error && data.error.message) || res.statusText);
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

// ---- Calendar (primary 캘린더) ----
function listEvents(params) {
  return apiFetch(`${CAL_BASE}/calendars/primary/events${qs(params)}`);
}
function insertEvent(body) {
  return apiFetch(`${CAL_BASE}/calendars/primary/events`, { method: 'POST', body });
}
function deleteEvent(eventId) {
  return apiFetch(`${CAL_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
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
  listEvents,
  insertEvent,
  deleteEvent,
  listTaskLists,
  listTasks,
  insertTask,
  patchTask,
  deleteTask,
};
