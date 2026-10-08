import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const $ = id => document.getElementById(id);
let terminal, fit, ws, retryTimer, retries = 0, signedIn = false, ctrl = false;
let resizeTimer, lastSize = '', keyboardOpen = false;
let restingHeight = window.innerHeight;
const terminalThemes = {
  dark: { background: '#11151b', foreground: '#dce5ef', cursor: '#a5e7c8', cursorAccent: '#11151b', selectionBackground: '#8fe1bc55', selectionInactiveBackground: '#8fe1bc33',
    black: '#202832', red: '#ef8080', green: '#8bd5a7', yellow: '#e7ca85', blue: '#85b7ef', magenta: '#cba0e8', cyan: '#80ccd2', white: '#dce5ef',
    brightBlack: '#758799', brightRed: '#ffaaaa', brightGreen: '#b1edc6', brightYellow: '#ffe3a3', brightBlue: '#acd0ff', brightMagenta: '#e1bdff', brightCyan: '#a4eaf0', brightWhite: '#ffffff' },
  light: { background: '#f7faf9', foreground: '#182833', cursor: '#226b4e', cursorAccent: '#ffffff', selectionBackground: '#226b4e44', selectionInactiveBackground: '#226b4e22',
    black: '#182833', red: '#a92c35', green: '#216b3d', yellow: '#795800', blue: '#245aa5', magenta: '#82419b', cyan: '#086c79', white: '#52675e',
    brightBlack: '#586e63', brightRed: '#ba2838', brightGreen: '#23703e', brightYellow: '#806000', brightBlue: '#275dc0', brightMagenta: '#8c3fac', brightCyan: '#08717c', brightWhite: '#354a40' },
};
const systemTheme = matchMedia('(prefers-color-scheme: light)');
let theme = systemTheme.matches ? 'light' : 'dark', explicitTheme = false;
try {
  const saved = localStorage.getItem('herdr-theme');
  if (saved === 'light' || saved === 'dark') { theme = saved; explicitTheme = true; }
} catch {} // Theme selection also works when storage is unavailable.
function applyTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = terminalThemes[theme].background;
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    button.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
    button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  });
  if (terminal) terminal.options.theme = terminalThemes[theme];
}
applyTheme(theme);
document.querySelectorAll('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => {
  explicitTheme = true;
  applyTheme(theme === 'dark' ? 'light' : 'dark');
  try { localStorage.setItem('herdr-theme', theme); } catch {}
  scheduleResize();
}));
systemTheme.addEventListener('change', event => { if (!explicitTheme) applyTheme(event.matches ? 'light' : 'dark'); });

const preferences = ['font-size', 'terminal-width'];
for (const id of preferences) {
  try {
    const saved = localStorage.getItem(`herdr-${id}`);
    if ([...$(id).options].some(option => option.value === saved)) $(id).value = saved;
    else if (id === 'font-size' && matchMedia('(max-width: 600px)').matches) $(id).value = '11';
  } catch {} // Browsing modes may disable preference storage.
}
const encoder = new TextEncoder();
const keys = { prefix: '\x02', escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', backspace: '\x7f' };
function send(message) { if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(message)); return true; } return false; }
function setCtrl(value) { ctrl = value; $('ctrl').setAttribute('aria-pressed', String(value)); }
function input(data) {
  if (ctrl && data.length === 1) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); setCtrl(false); }
  return send({ type: 'input', data });
}
function resize() {
  if (!fit || $('workspace').hidden || !$('terminal-scroller').clientHeight) return;
  const container = $('terminal');
  container.style.width = '100%';
  const proposed = fit.proposeDimensions();
  if (!proposed) return;
  let cols = Math.max(20, Math.min(500, proposed.cols));
  if ($('terminal-width').value !== 'fit') {
    const cellWidth = terminal.element.querySelector('.xterm-screen').getBoundingClientRect().width / terminal.cols;
    cols = Number($('terminal-width').value);
    container.style.width = `${Math.max($('terminal-scroller').clientWidth, Math.ceil(cols * cellWidth + 24))}px`;
  }
  const rows = Math.max(5, Math.min(200, proposed.rows));
  terminal.resize(cols, rows);
  $('size').textContent = `${cols} × ${rows}`;
  const size = `${cols}:${rows}`;
  if (lastSize !== size && send({ type: 'resize', cols, rows })) lastSize = size;
}
function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 100);
}
function viewport() {
  const view = window.visualViewport;
  // Leave native pinch zoom alone; otherwise follow the area above the keyboard.
  if (view && view.scale !== 1) return;
  const height = view?.height || window.innerHeight;
  $('workspace').style.height = `${height}px`;
  $('workspace').style.width = `${view?.width || window.innerWidth}px`;
  $('workspace').style.top = `${view?.offsetTop || 0}px`;
  $('workspace').style.left = `${view?.offsetLeft || 0}px`;
  const editing = document.activeElement?.matches('textarea, input');
  if (!editing) restingHeight = height;
  keyboardOpen = !!editing && (Math.max(restingHeight, window.innerHeight) - height > 100 || height < 450);
  $('workspace').classList.toggle('keyboard-open', keyboardOpen);
  $('keyboard').textContent = keyboardOpen ? 'Hide ⌄' : 'Keyboard';
  $('keyboard').setAttribute('aria-pressed', String(keyboardOpen));
  scheduleResize();
}
function growComposer() {
  $('message').style.height = 'auto';
  $('message').style.height = `${Math.min(96, $('message').scrollHeight)}px`;
  scheduleResize();
}
function loginView(message = '') {
  signedIn = false; clearTimeout(retryTimer); clearTimeout(resizeTimer);
  document.body.classList.remove('in-workspace'); setCtrl(false);
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); ws = null; }
  terminal?.dispose(); terminal = null; fit = null;
  $('terminal').replaceChildren();
  $('workspace').hidden = true; $('login').hidden = false;
  $('login-error').textContent = message;
}
async function checkSession() {
  const response = await fetch('/api/session');
  if (!response.ok) return false;
  const data = await response.json();
  $('session-name').textContent = data.session;
  return true;
}
function connect() {
  clearTimeout(retryTimer);
  if (!signedIn) return;
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); }
  $('status').textContent = 'Connecting…'; $('reconnect').hidden = true;
  $('notice').hidden = true;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal`);
  ws = socket;
  socket.onopen = () => { lastSize = ''; terminal.reset(); resize(); };
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'output') terminal.write(msg.data, () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', bytes: encoder.encode(msg.data).length }));
    });
    if (msg.type === 'ready') { retries = 0; $('status').textContent = '● Connected'; }
    if (msg.type === 'error') { $('notice').textContent = msg.message; $('notice').hidden = false; }
  };
  socket.onclose = async event => {
    $('status').textContent = 'Disconnected'; $('reconnect').hidden = false;
    if (event.code === 4001) return loginView('Your session expired. Sign in to reconnect.');
    if (event.code === 4002) { $('notice').textContent = 'Herdr detached. Reconnect to return to your session.'; $('notice').hidden = false; return; }
    try { if (!await checkSession()) return loginView('Sign in to reconnect.'); } catch {}
    if (!signedIn || ws !== socket) return;
    const delay = Math.min(1000 * 2 ** retries++, 15000);
    $('status').textContent = 'Reconnecting…';
    retryTimer = setTimeout(connect, delay);
  };
}
function workspace() {
  signedIn = true; document.body.classList.add('in-workspace'); $('login').hidden = true; $('workspace').hidden = false;
  terminal = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: Number($('font-size').value), theme: terminalThemes[theme], scrollback: 5000, allowProposedApi: false });
  fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($('terminal'));
  terminal.onData(input);
  viewport(); connect();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-button').disabled = true; $('login-error').textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: $('token').value.trim(), remember: $('remember').checked }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    $('token').value = ''; await checkSession(); workspace();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Sign out failed');
    loginView();
  } catch { $('notice').textContent = 'Unable to sign out. Check your connection and try again.'; $('notice').hidden = false; }
});
$('reconnect').addEventListener('click', connect);
$('ctrl').addEventListener('pointerdown', event => event.preventDefault());
$('ctrl').addEventListener('click', () => setCtrl(!ctrl));
document.querySelectorAll('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => input(keys[button.dataset.key]));
});
$('keyboard').addEventListener('pointerdown', event => event.preventDefault());
$('keyboard').addEventListener('click', () => {
  if (document.activeElement?.matches('textarea, input')) document.activeElement.blur();
  else terminal?.focus();
  viewport();
});
$('focus-mode').addEventListener('click', () => {
  const focused = $('workspace').classList.toggle('focused');
  $('focus-mode').setAttribute('aria-pressed', String(focused));
  $('focus-mode').textContent = focused ? 'Exit focus' : 'Focus';
  scheduleResize();
});
for (const id of preferences) $(id).addEventListener('change', () => {
  try { localStorage.setItem(`herdr-${id}`, $(id).value); } catch {}
  if (terminal) { terminal.options.fontSize = Number($('font-size').value); scheduleResize(); }
});
$('message').addEventListener('input', growComposer);
$('compose').querySelector('button').addEventListener('pointerdown', event => event.preventDefault());
$('compose').addEventListener('submit', event => {
  event.preventDefault();
  const data = $('message').value;
  // Bracketed paste preserves multiline prompts in applications that enable it.
  if (ws?.readyState !== WebSocket.OPEN || !terminal) return;
  terminal.paste(data);
  input('\r'); $('message').value = ''; growComposer();
});
new ResizeObserver(scheduleResize).observe($('terminal-scroller'));
window.visualViewport?.addEventListener('resize', viewport);
window.visualViewport?.addEventListener('scroll', viewport);
window.addEventListener('resize', viewport);
document.addEventListener('focusin', viewport);
document.addEventListener('focusout', () => setTimeout(viewport, 0));
document.addEventListener('visibilitychange', () => { if (!document.hidden && signedIn && ws?.readyState === WebSocket.CLOSED) connect(); });
try { if (await checkSession()) workspace(); } catch { $('login-error').textContent = 'Cannot reach the server. Try again when connected.'; }
