'use strict';
// 아주 작은 JSON 파일 영속화 모듈. 원자적 쓰기(tmp 파일 → rename)로 손상 방지.
// Electron 없이도 동작해야 함(테스트에서 순수 Node로 사용).
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath, defaults, opts) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.mergeOnWrite = !!(opts && opts.mergeOnWrite);
    this.data = this._load();
  }

  _load() {
    // 백신/색인 등이 파일을 잠깐 잡고 있으면 읽기가 일시적으로 실패할 수 있다.
    // 그때 기본값으로 떠버리면 설정(할 일 캘린더 연결 등)이 사라진 것처럼 보이고,
    // 이후 저장이 정상 파일을 덮어써 데이터가 실제로 파괴된다. 반드시 재시도한다.
    let lastErr = null;
    for (let i = 0; i < 5; i++) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Object.assign(structuredClone(this.defaults), parsed);
      } catch (e) {
        lastErr = e;
        if (e && e.code === 'ENOENT') break; // 파일이 없으면 정상적인 첫 실행
        // 동기적으로 잠깐 대기 후 재시도
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); } catch { /* 무시 */ }
      }
    }
    if (lastErr && lastErr.code !== 'ENOENT') {
      // 파일이 있는데도 못 읽었다 — 조용히 넘어가지 않고 흔적을 남긴다
      const line = new Date().toISOString() + '  !! 저장 파일 읽기 실패(기본값으로 시작): '
        + this.filePath + ' — ' + lastErr.message + '\n';
      console.error(line.trim());
      try {
        fs.appendFileSync(path.join(path.dirname(this.filePath), 'sync.log'), line);
      } catch { /* 무시 */ }
      this.loadFailed = true;
    }
    return structuredClone(this.defaults);
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  // mergeOnWrite(설정 파일)일 때는 저장 직전에 디스크를 다시 읽어, 바꾸려는 항목만 덮는다.
  // 같은 파일을 두 프로세스가 쓰면 나중에 저장한 쪽이 상대의 설정을 통째로 날려버리기 때문이다.
  // 캐시처럼 메모리에서 직접 고치는 저장소에는 쓰면 안 된다(받아온 데이터가 사라진다).
  update(partial) {
    if (this.mergeOnWrite) {
      this.data = Object.assign(this._load(), partial);
    } else {
      Object.assign(this.data, partial);
    }
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
    settings: new JsonStore(path.join(dir, 'settings.json'), DEFAULTS.settings, { mergeOnWrite: true }),
    tokens: new JsonStore(path.join(dir, 'tokens.json'), DEFAULTS.tokens),
    cache: new JsonStore(path.join(dir, 'cache.json'), DEFAULTS.cache),
    pending: new JsonStore(path.join(dir, 'pending.json'), DEFAULTS.pending),
  };
}

module.exports = { JsonStore, createStores, DEFAULTS };
