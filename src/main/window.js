'use strict';
// 위젯 창: 프레임 없음, 투명(둥근 모서리), 고정 크기, 우측 하단 배치, 핀(항상 위) 토글
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, screen } = require('electron');

const WIDTH = 360;
const HEIGHT = 540;
const MARGIN = 12;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 380;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 1400;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 저장된 크기(없거나 이상하면 기본값)
function currentSize() {
  const s = settingsStore.data.windowSize;
  if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) {
    return {
      width: Math.round(clamp(s.width, MIN_WIDTH, MAX_WIDTH)),
      height: Math.round(clamp(s.height, MIN_HEIGHT, MAX_HEIGHT)),
    };
  }
  return { width: WIDTH, height: HEIGHT };
}

let win = null;
let settingsStore = null;
let isQuitting = () => false;
let createOpts = null;   // 창을 다시 만들 때 쓰려고 보관
let saveMoveTimer = null;
let saveSizeTimer = null;

function create(store, opts) {
  settingsStore = store;
  if (opts) createOpts = opts;
  if (opts && opts.isQuitting) isQuitting = opts.isQuitting;

  const size = currentSize();
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    frame: false,
    // 투명 창은 Electron 제약상 크기 조절이 불가능하다.
    // 대신 불투명 배경 + Windows 11이 자동으로 둥글려주는 모서리를 쓴다.
    transparent: false,
    backgroundColor: '#1b1d23',
    roundedCorners: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: !!settingsStore.data.pinned,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      spellcheck: false,
    },
  });

  // 렌더러는 로컬 index.html에 고정 — 외부로의 내비게이션/새 창을 차단해
  // 만에 하나의 스크립트 주입이 preload API(window.api)에 접근하지 못하게 한다
  const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const indexUrl = pathToFileURL(indexPath).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== indexUrl) e.preventDefault();
  });

  applyPosition();
  win.loadFile(indexPath);

  win.once('ready-to-show', () => {
    if (settingsStore.data.pinned) win.setAlwaysOnTop(true, 'floating');
    win.show();
  });

  // 헤더 ✕/close = 숨기기 (종료는 트레이에서만)
  win.on('close', (e) => {
    if (!isQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });

  // Windows 종료/재시작/로그오프: close-preventDefault가 세션 종료를 막지 않게 한다
  win.on('session-end', () => {
    clearTimeout(saveMoveTimer);
    if (opts && opts.onSessionEnd) opts.onSessionEnd();
  });

  // 드래그로 옮긴 위치 저장 (디바운스)
  win.on('moved', () => {
    clearTimeout(saveMoveTimer);
    saveMoveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      settingsStore.update({ windowPos: { x, y } });
    }, 500);
  });

  // 사용자가 조절한 크기 저장 (디바운스)
  win.on('resized', () => {
    clearTimeout(saveSizeTimer);
    saveSizeTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [width, height] = win.getSize();
      settingsStore.update({ windowSize: { width, height } });
    }, 500);
  });

  // 해상도/배율/모니터 변경 시 화면 밖으로 나가지 않게
  screen.on('display-metrics-changed', ensureOnScreen);
  screen.on('display-added', ensureOnScreen);
  screen.on('display-removed', ensureOnScreen);

  return win;
}

function get() { return win && !win.isDestroyed() ? win : null; }

// 창이 없거나 파괴됐으면 다시 만든다.
// 메인 프로세스만 살아남고 창이 사라지면(렌더러 강제 종료 등) 앱이 유령처럼 떠 있으면서
// 중복 실행 방지에만 걸려, 아이콘을 눌러도 아무 일도 일어나지 않는 상태가 된다.
function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  if (!settingsStore) return null;
  console.log('[window] 창이 없어 다시 만듭니다');
  return create(settingsStore, createOpts || {});
}

function bottomRightBounds() {
  const wa = screen.getPrimaryDisplay().workArea; // 작업표시줄 제외 영역
  const { width, height } = liveSize();
  return {
    x: wa.x + wa.width - width - MARGIN,
    y: wa.y + wa.height - height - MARGIN,
  };
}

// 현재 실제 창 크기(창이 없으면 저장된 크기)
function liveSize() {
  if (win && !win.isDestroyed()) {
    const [width, height] = win.getSize();
    return { width, height };
  }
  return currentSize();
}

// setPosition은 배율(DPI)이 100%가 아닐 때 창 크기를 왜곡하는 오래된
// Electron/Windows 버그가 있어, 크기를 함께 명시하는 setBounds를 쓴다
function moveTo(x, y) {
  const { width, height } = liveSize();
  win.setBounds({ x, y, width, height });
}

function applyPosition() {
  const saved = settingsStore.data.windowPos;
  if (saved && isVisibleOnSomeDisplay(saved)) {
    moveTo(saved.x, saved.y);
  } else {
    const p = bottomRightBounds();
    moveTo(p.x, p.y);
  }
}

function isVisibleOnSomeDisplay(pos) {
  const { width } = liveSize();
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    // 창의 상당 부분이 이 디스플레이 안에 있는지
    return pos.x + width - 40 > wa.x && pos.x + 40 < wa.x + wa.width
      && pos.y + 40 > wa.y && pos.y + 60 < wa.y + wa.height;
  });
}

function ensureOnScreen() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  if (!isVisibleOnSomeDisplay({ x, y })) {
    const p = bottomRightBounds();
    moveTo(p.x, p.y);
  }
}

// 위치와 크기를 모두 기본값(우측 하단, 360x540)으로 되돌린다
function resetPosition() {
  settingsStore.update({ windowPos: null, windowSize: null });
  if (win && !win.isDestroyed()) win.setSize(WIDTH, HEIGHT);
  const p = bottomRightBounds();
  moveTo(p.x, p.y);
}

function setPinned(pinned) {
  settingsStore.update({ pinned: !!pinned });
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!pinned, 'floating');
}

function show() {
  const w = ensureWindow();
  if (!w) return;
  if (w.isMinimized()) w.restore(); // Win+D 등으로 최소화된 경우 복원
  w.show();
  w.focus();
}
function hide() { const w = get(); if (w) w.hide(); }
function toggleVisibility() {
  const w = get();
  if (!w) { show(); return; } // 창이 죽어 있으면 되살린다
  if (w.isVisible() && !w.isMinimized()) w.hide();
  else show();
}

module.exports = { create, get, ensureWindow, setPinned, resetPosition, show, hide, toggleVisibility };
