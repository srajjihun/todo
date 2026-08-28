'use strict';
// 위젯 창: 프레임 없음, 투명(둥근 모서리), 고정 크기, 우측 하단 배치, 핀(항상 위) 토글
const path = require('path');
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

  applyPosition();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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

  // 드래그로 옮긴 위치 저장 (디바운스)
  win.on('moved', () => {
    clearTimeout(saveMoveTimer);
    saveMoveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
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

function applyPosition() {
  const saved = settingsStore.data.windowPos;
  if (saved && isVisibleOnSomeDisplay(saved)) {
    win.setPosition(saved.x, saved.y);
  } else {
    const p = bottomRightBounds();
    win.setPosition(p.x, p.y);
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
    win.setPosition(p.x, p.y);
  }
}

function resetPosition() {
  settingsStore.update({ windowPos: null });
  const p = bottomRightBounds();
  win.setPosition(p.x, p.y);
}

function setPinned(pinned) {
  settingsStore.update({ pinned: !!pinned });
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!pinned, 'floating');
}

function show() {
  if (!win) return;
  win.show();
  win.focus();
}
function hide() { if (win) win.hide(); }
function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else show();
}

module.exports = { create, get, setPinned, resetPosition, show, hide, toggleVisibility };
