'use strict';
// 위젯 창: 프레임 없음, 투명(둥근 모서리), 고정 크기, 우측 하단 배치, 핀(항상 위) 토글
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, screen } = require('electron');

const WIDTH = 360;
const HEIGHT = 540;
const MARGIN = 12;

let win = null;
let settingsStore = null;
let isQuitting = () => false;
let saveMoveTimer = null;

function create(store, opts) {
  settingsStore = store;
  if (opts && opts.isQuitting) isQuitting = opts.isQuitting;

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
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

  // 드래그로 옮긴 위치 저장 (디바운스) + 다른 배율의 모니터로 끌었을 때 크기 재고정
  win.on('moved', () => {
    clearTimeout(saveMoveTimer);
    saveMoveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [w, h] = win.getSize();
      if (w !== WIDTH || h !== HEIGHT) win.setSize(WIDTH, HEIGHT);
      const [x, y] = win.getPosition();
      settingsStore.update({ windowPos: { x, y } });
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
  return {
    x: wa.x + wa.width - WIDTH - MARGIN,
    y: wa.y + wa.height - HEIGHT - MARGIN,
  };
}

// setPosition은 배율(DPI) 100% 아님 + resizable:false 조합에서 창 크기를 왜곡하는
// 오래된 Electron/Windows 버그가 있어, 항상 크기를 함께 다시 지정한다
function moveTo(x, y) {
  win.setBounds({ x, y, width: WIDTH, height: HEIGHT });
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
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    // 창의 상당 부분이 이 디스플레이 안에 있는지
    return pos.x + WIDTH - 40 > wa.x && pos.x + 40 < wa.x + wa.width
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

function resetPosition() {
  settingsStore.update({ windowPos: null });
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
