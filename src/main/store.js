'use strict';
// 아주 작은 JSON 파일 영속화 모듈. 원자적 쓰기(tmp 파일 → rename)로 손상 방지.
// Electron 없이도 동작해야 함(테스트에서 순수 Node로 사용).
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign(structuredClone(this.defaults), parsed);
    } catch {
      return structuredClone(this.defaults);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  update(partial) {
    Object.assign(this.data, partial);
    this.save();
    return this.data;
  }

  // 파일 삭제 + 메모리 초기화 (로그아웃 시 tokens.json 등)
  reset() {
    try { fs.unlinkSync(this.filePath); } catch { /* 없으면 무시 */ }
    this.data = structuredClone(this.defaults);
  }
}

const DEFAULTS = {
  settings: {
    clientId: '',
    clientSecret: '',
    taskListId: '@default',
    todoCalendarId: null,      // 전용 '할 일' 캘린더 (null이면 미사용)
    visibleCalendarIds: null,  // 캘린더 탭에 표시할 캘린더 (null이면 전체)
    syncIntervalMin: 180,
    pinned: false,
    autoLaunch: false,
    windowPos: null,
    windowSize: null,
    miniPinned: true,
    miniPos: null,
    pomoFocusMin: 25,
    pomoShortBreakMin: 5,
    pomoLongBreakMin: 15,
    pomoLongBreakEvery: 4,
    pomoAutoStartBreak: true,
    pomoAutoStartFocus: true,
  },
  tokens: { refreshTokenEnc: null, encrypted: false },
  cache: {
    events: {},
    eventsSyncTokens: {},   // 캘린더별 증분 동기화 토큰
    calendars: [],          // 캘린더 목록 캐시
    todoMasters: {},        // 반복 할 일 마스터(반복 규칙 + 완료 원장)
    tasks: {},
    lastSyncAt: null,
    pomoDate: null,
    pomoCount: 0,
    focusTaskId: null,
    focusTaskTitle: null,
  },
  pending: { ops: [] },
};

function createStores(dir) {
  return {
    settings: new JsonStore(path.join(dir, 'settings.json'), DEFAULTS.settings),
    tokens: new JsonStore(path.join(dir, 'tokens.json'), DEFAULTS.tokens),
    cache: new JsonStore(path.join(dir, 'cache.json'), DEFAULTS.cache),
    pending: new JsonStore(path.join(dir, 'pending.json'), DEFAULTS.pending),
  };
}

module.exports = { JsonStore, createStores, DEFAULTS };
