'use strict';
// Google OAuth2 — 설치형 앱 loopback 흐름 (127.0.0.1 임시 포트) + PKCE(S256)
// 액세스 토큰은 메모리에만, 리프레시 토큰은 safeStorage(DPAPI)로 암호화해 tokens.json에 저장.
const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage } = require('electron');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  // 캘린더 목록(공휴일 등 구독 캘린더, 전용 '할 일' 캘린더)을 읽기 위해 필요
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

class AuthRequiredError extends Error {
  constructor(message = '로그인이 필요합니다') { super(message); this.name = 'AuthRequiredError'; }
}

let settingsStore = null;
let tokensStore = null;
let accessToken = null;
let accessTokenExpiry = 0; // epoch ms
let refreshToken = null;
let loginInFlight = null;
const changeListeners = new Set();

function init(stores) {
  settingsStore = stores.settings;
  tokensStore = stores.tokens;
  refreshToken = loadRefreshToken();
}

function onChange(cb) { changeListeners.add(cb); }
function emitChange() {
  for (const cb of changeListeners) {
    try { cb({ loggedIn: isLoggedIn() }); } catch { /* listener 오류 무시 */ }
  }
}

function isLoggedIn() { return !!refreshToken; }

function loadRefreshToken() {
  const { refreshTokenEnc, encrypted } = tokensStore.data;
  if (!refreshTokenEnc) return null;
  try {
    if (encrypted) {
      return safeStorage.decryptString(Buffer.from(refreshTokenEnc, 'base64'));
    }
    return Buffer.from(refreshTokenEnc, 'base64').toString('utf8');
  } catch {
    return null; // 복호화 실패(다른 계정/OS 재설치 등) → 재로그인 필요
  }
}

function saveRefreshToken(token) {
  if (safeStorage.isEncryptionAvailable()) {
    tokensStore.update({
      refreshTokenEnc: safeStorage.encryptString(token).toString('base64'),
      encrypted: true,
    });
  } else {
    console.warn('[auth] safeStorage 사용 불가 — 리프레시 토큰을 평문(base64)으로 저장합니다');
    tokensStore.update({
      refreshTokenEnc: Buffer.from(token, 'utf8').toString('base64'),
      encrypted: false,
    });
  }
}

function logout() {
  tokensStore.reset();
  refreshToken = null;
  accessToken = null;
  accessTokenExpiry = 0;
  emitChange();
}

function invalidateAccessToken() { accessToken = null; accessTokenExpiry = 0; }

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60000) return accessToken;
  if (!refreshToken) throw new AuthRequiredError();
  return refreshAccessToken();
}

async function refreshAccessToken() {
  const { clientId, clientSecret } = settingsStore.data;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 리프레시 토큰 폐기됨(권한 회수, 테스트 앱 7일 만료 등) → 로그아웃 처리
    if (data.error === 'invalid_grant') {
      logout();
      throw new AuthRequiredError('로그인이 만료되었습니다. 다시 로그인해주세요.');
    }
    const err = new Error(`토큰 갱신 실패: ${data.error_description || data.error || res.status}`);
    err.status = res.status;
    throw err;
  }
  accessToken = data.access_token;
  accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  // 구글이 리프레시 토큰을 회전(재발급)해 주면 새 토큰으로 교체 저장
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    saveRefreshToken(data.refresh_token);
  }
  return accessToken;
}

async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = doLogin().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

async function doLogin() {
  const { clientId, clientSecret } = settingsStore.data;
  if (!clientId || !clientSecret) {
    throw new Error('먼저 설정에서 클라이언트 ID와 클라이언트 보안 비밀을 입력해주세요.');
  }

  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  const { code, redirectUri } = await receiveAuthCode({ clientId, codeChallenge, state });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`토큰 교환 실패: ${data.error_description || data.error || res.status}`);
  }
  if (!data.refresh_token) {
    throw new Error('리프레시 토큰을 받지 못했습니다. 구글 계정 보안 설정에서 앱 액세스 권한을 삭제한 뒤 다시 시도해주세요.');
  }

  saveRefreshToken(data.refresh_token);
  refreshToken = data.refresh_token;
  accessToken = data.access_token;
  accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  emitChange();
  return { ok: true };
}

// loopback 서버를 열고 브라우저 동의 후 돌아오는 code를 기다린다
function receiveAuthCode({ clientId, codeChallenge, state }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }

      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || !code || gotState !== state) {
        res.end(pageHtml('로그인에 실패했습니다', err === 'access_denied'
          ? '권한 요청이 거부되었습니다. 위젯에서 다시 시도해주세요.'
          : '위젯으로 돌아가 다시 시도해주세요.'));
        finish(() => reject(new Error(err === 'access_denied'
          ? '로그인이 거부되었습니다. OAuth 동의 화면의 테스트 사용자에 본인 계정이 등록되어 있는지 확인해주세요.'
          : `로그인 실패: ${err || 'code 없음'}`)));
        return;
      }
      res.end(pageHtml('로그인이 완료되었습니다', '이 창은 닫으셔도 됩니다. 위젯으로 돌아가세요.'));
      finish(() => resolve({ code, redirectUri }));
    });

    let redirectUri = null;
    let timer = null;
    const finish = (cb) => {
      clearTimeout(timer);
      server.close();
      cb();
    };

    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      })}`;
      shell.openExternal(authUrl);
      timer = setTimeout(() => {
        server.close();
        reject(new Error('로그인 시간이 초과되었습니다(5분). 다시 시도해주세요.'));
      }, LOGIN_TIMEOUT_MS);
    });
  });
}

function pageHtml(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:'Segoe UI','Malgun Gothic',sans-serif;background:#1b1d23;color:#e6e6e9;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:40px}h1{font-size:22px;margin:0 0 12px}p{color:#9a9aa5;margin:0}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

module.exports = {
  init,
  login,
  logout,
  isLoggedIn,
  getAccessToken,
  invalidateAccessToken,
  onChange,
  AuthRequiredError,
};
