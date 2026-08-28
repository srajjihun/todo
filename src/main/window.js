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
let saveMoveTimer = null;
let saveSizeTimer = null;

function create(store, opts) {
  settingsStore = store;
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
    transparent: true,
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

function get() { return win; }

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
  if (!win) return;
  if (win.isMinimized()) win.restore(); // Win+D 등으로 최소화된 경우 복원
  win.show();
  win.focus();
}
function hide() { if (win) win.hide(); }
function toggleVisibility() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else show();
}

module.exports = { create, get, setPinned, resetPosition, show, hide, toggleVisibility };
