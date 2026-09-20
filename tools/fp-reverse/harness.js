// fp.min.js payload 逆向 harness：
// 1. 打补丁让 AES.encrypt 的明文泄漏到 globalThis.__lastPlain
// 2. 提供最小浏览器桩，让 SDK 走到 deviceprofile 提交
// 3. 捕获 XHR 请求体（最终线缆格式）
const fs = require('fs');

let code = fs.readFileSync(process.argv[2] || 'fp.min.js', 'utf8');

// ── 补丁 1：泄漏 AES 明文（CryptoJS 调用点，逗号表达式注入）──
const AES_CALL = "_0x54fe30['AES']['encrypt'](_0x527184,_0x55d7b3,";
if (!code.includes(AES_CALL)) {
  console.error('PATCH1 FAILED: AES call site not found');
  process.exit(1);
}
code = code.replace(
  AES_CALL,
  "globalThis.__lastPlain=(typeof _0x527184==='string'?_0x527184:String(_0x527184)),globalThis.__aesKeyHex=(typeof _0x55d7b3.toString==='function'?_0x55d7b3.toString():String(_0x55d7b3)),globalThis.__aesIvHex=(typeof _0x401bc7.toString==='function'?_0x401bc7.toString():String(_0x401bc7)),_0x54fe30['AES']['encrypt'](_0x527184,_0x55d7b3,"
);
console.error('[patch] AES plaintext leak: ok');

// ── 补丁 2：泄漏 RSA 输入（uid）──
const RSA_CALL_RE = /\['rsaEncrypt'\]=function\(_0x395634,_0x435ad9\)\{/;
if (RSA_CALL_RE.test(code)) {
  code = code.replace(RSA_CALL_RE, "['rsaEncrypt']=function(_0x395634,_0x435ad9){globalThis.__lastUid=_0x395634;")
  console.error('[patch] RSA uid leak: ok');
} else {
  console.error('[patch] RSA call site not found (non-fatal)');
}

// ── 浏览器环境桩 ──
const FAKE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function mkCtx2d() {
  const state = { fillStyle: '', strokeStyle: '', textBaseline: '', font: '', globalCompositeOperation: '', globalAlpha: 1 };
  const noop = function () {};
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4).fill(128), width: w, height: h });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'createPattern') return () => ({});
      if (k === 'canvas') return null;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    innerHTML: '',
    textContent: '',
    contentWindow: null,
    width: 300,
    height: 150,
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener() {},
    removeEventListener() {},
  };
  if (String(tag).toLowerCase() === 'canvas') {
    el.getContext = function (type) {
      if (type === '2d') return (el._ctx2d = el._ctx2d || mkCtx2d());
      return null; // webgl 故意不可用（SDK 应容忍并留空字段）
    };
    el.toDataURL = function () { return FAKE_DATA_URL; };
    el.toBlob = function (cb) { cb({}); };
  }
  return el;
}

const captured = [];
globalThis.XMLHttpRequest = function () {
  this.readyState = 0;
  this.status = 0;
  this.responseText = '';
  this.response = '';
  this.open = function (method, url) { this._method = method; this._url = url; };
  this.setRequestHeader = function (k, v) {};
  this.send = function (body) {
    captured.push({ method: this._method, url: this._url, body });
    // 模拟服务端响应（biz_code 0 让 SDK 走成功分支）
    this.readyState = 4;
    this.status = 200;
    this.responseText = JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { deviceId: 'CAPTURED_FROM_SERVER_SIDE' } } });
    this.onreadystatechange && this.onreadystatechange();
    this.onload && this.onload();
  };
  this.abort = function () {};
  this.setRequestHeader.toString = () => 'function setRequestHeader() { [native code] }';
};

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = {
  location: { protocol: 'https:', host: 'chat.deepseek.com', href: 'https://chat.deepseek.com/sign_in', pathname: '/sign_in' },
  head: mkEl('head'),
  body: mkEl('body'),
  documentElement: mkEl('html'),
  cookie: '',
  referrer: '',
  readyState: 'complete',
  hidden: false,
  visibilityState: 'visible',
  createElement: function (tag) { return mkEl(tag); },
  createTextNode(t) { return { text: t }; },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  attachEvent() {},
};
globalThis.navigator = {
  userAgent: 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  appName: 'Netscape', appCodeName: 'Mozilla', appVersion: '5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  platform: 'Linux aarch64', language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'],
  hardwareConcurrency: 4, deviceMemory: 1, maxTouchPoints: 0, vendor: 'Google Inc.',
  cookieEnabled: true, doNotTrack: null, onLine: true,
  webdriver: false,
  plugins: { length: 0 },
  mimeTypes: { length: 0 },
  getBattery() { return Promise.resolve({ charging: true, level: 1 }); },
  javaEnabled() { return false; },
  getStorageUpdates() {},
};
globalThis.location = globalThis.document.location;
globalThis.chrome = { runtime: {}, app: { isInstalled: false } };
globalThis.parent = globalThis;
globalThis.top = globalThis;
globalThis.frames = globalThis;
globalThis.opener = null;
globalThis.external = {};
globalThis.name = '';
globalThis.innerWidth = 280; globalThis.innerHeight = 936;
globalThis.outerWidth = 280; globalThis.outerHeight = 936;
globalThis.screenLeft = 0; globalThis.screenTop = 0;
globalThis.screenX = 0; globalThis.screenY = 0;
globalThis.devicePixelRatio = 1;
globalThis.scrollX = 0; globalThis.scrollY = 0; pageXOffset = 0; pageYOffset = 0;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.matchMedia = () => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {} });
globalThis.getComputedStyle = () => new Proxy({}, { get: () => '' });
globalThis.Notification = { permission: 'default' };
globalThis.speechSynthesis = { getVoices() { return []; } };
globalThis.screen = { width: 280, height: 936, availWidth: 280, availHeight: 936, colorDepth: 24, pixelDepth: 24 };
globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
})();
globalThis.sessionStorage = (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() };
})();
globalThis.indexedDB = undefined;
globalThis.performance = { now: () => Date.now(), timeOrigin: Date.now(), timing: {} };
globalThis.crypto = globalThis.crypto || { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; }, subtle: undefined };
globalThis.Worker = undefined;
globalThis.WebSocket = undefined;
globalThis.AudioContext = undefined;
globalThis.webkitAudioContext = undefined;
globalThis.OfflineAudioContext = undefined;
globalThis.open = () => null;
globalThis.history = { length: 1, pushState() {}, replaceState() {}, back() {}, go() {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.attachEvent = undefined;
globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
globalThis._smConf = {
  organization: 'P9usCUBauxft8eAmUXaZ',
  appId: 'default',
  publicKey: 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDetfEgYD4aE1ZjmWJ6/jnPurhzI+yeRoJHWrnNtQMte3stQ4VjG3yu21FuN75E6cDpA9KtDXwcB2M/FiGUAe3G0rNotbWI8+SjZfUbW/OILFTzY0uaeEkmVGW5WyJ6weQbbr1xTCPa2OO3YIMeZljWUYHG5h21WAm/PATg8im8cQIDAQAB',
  protocol: 'https',
  apiHost: 'fp-it-acc.portal101.cn',
  apiPath: '/deviceprofile/v4',
};

// ── 执行 SDK ──
try {
  eval(code);
  console.error('[run] fp.min.js evaluated');
} catch (e) {
  console.error('[run] eval threw:', e.message);
}

// 等待异步流程（SDK 有 setTimeout 轮询/重试）
setTimeout(() => {
  console.error('\n===== CAPTURED XHR =====');
  for (const c of captured) {
    console.error('URL:', c.method, c.url);
    console.error('BODY type:', typeof c.body, 'len:', c.body ? String(c.body).length : 0);
    console.error('BODY:', String(c.body).slice(0, 2000));
    console.error('-'.repeat(60));
  }
  console.error('\n===== CANONICAL STR =====');
  if (globalThis.__canonicalStr) {
    require('fs').writeFileSync('canonical-js.txt', globalThis.__canonicalStr);
    if (globalThis.__canonicalConcat) require('fs').writeFileSync('canonical-concat.txt', globalThis.__canonicalConcat);
    console.error('canonical len:', globalThis.__canonicalStr.length, '(written to canonical-js.txt)');
  } else {
    console.error('(canonical not captured)');
  }
  console.error('\n===== LAST PLAIN (pre-AES) =====');
  console.error('AES key(hex):', globalThis.__aesKeyHex);
  console.error('AES iv(hex):', globalThis.__aesIvHex);
  const p = globalThis.__lastPlain;
  if (p) {
    console.error('type:', typeof p, 'len:', p.length);
    console.error(p.slice(0, 3000));
    try {
      const j = JSON.parse(p);
      console.error('\n--- parsed keys ---');
      console.error(JSON.stringify(j, null, 1).slice(0, 4000));
    } catch (e) { /* 非纯 JSON（可能含 gzip 后内容） */ }
  } else {
    console.error('(AES never called)');
  }
  console.error('\n===== UID =====');
  console.error(globalThis.__lastUid);
  process.exit(0);
}, 3000);
