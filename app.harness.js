/* =====================================================================
   app.harness.js — стенд для проверки НАСТОЯЩЕГО прикладного кода из index.html без браузера (Deno).

   Что это:  в один изолированный scope (new Function) кладутся ТЕКСТ core.js + ТЕКСТ основного скрипта index.html
             (без загрузочного блока «applyTheme(); load(); …») — ровно как браузер: два классических скрипта в общем
             глобальном scope. Поэтому тестируются НЕ копии, а те же функции: persistState, applyState, normalize,
             createBackup/getBackups, restoreBackup, importData, syncConnect/syncNow/syncPull/syncPush, saveAccount, …

   Что подменено (фейки с управляемыми отказами):
     • localStorage — Map; failSet / failKeys имитируют переполнение (QuotaExceededError);
     • indexedDB    — минимальная реализация open/transaction/objectStore(put,getAll,delete); отказы: open / put-abort;
     • fetch        — GitHub Gist API (GET/POST/PATCH /gists…) с общим «сервером» для нескольких устройств; offline/ошибки;
     • setTimeout   — очередь (flush() выполняет), Date — монотонные часы, FileReader, DOM — «универсальная заглушка».
   Что НЕ покрыто (честная граница): вёрстка/DOM, реальные движки IndexedDB/localStorage, реальный GitHub и сеть, Service Worker.
   Это именно fake-тест адаптеров, а НЕ тест в настоящем браузере; ручной тест на двух устройствах остаётся за владельцем.

   Запуск:  deno run --allow-read app.test.js
   ===================================================================== */
import { readFileSync } from 'node:fs';

const REAL = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
const tick0 = () => new Promise(r => REAL.setTimeout(r, 0));

/* ---------- Универсальная заглушка DOM: любой доступ/вызов возвращает её же ---------- */
export function makeStub() {
  const target = function () {};
  let proxy;
  proxy = new Proxy(target, {
    get(_, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === Symbol.iterator) return function* () {};
      if (p === 'then') return undefined;                        // не thenable
      if (p === 'length') return 0;
      if (p === 'toString' || p === 'valueOf') return () => '';
      return proxy;
    },
    set() { return true; }, apply() { return proxy; }, construct() { return proxy; }, has() { return true; },
  });
  return proxy;
}

/* ---------- localStorage ---------- */
export class FakeStorage {
  constructor() { this.m = new Map(); this.failSet = false; this.failKeys = new Set(); this.writes = []; }
  getItem(k) { return this.m.has(String(k)) ? this.m.get(String(k)) : null; }
  setItem(k, v) {
    k = String(k);
    if (this.failSet || this.failKeys.has(k)) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.m.set(k, String(v)); this.writes.push(k);
  }
  removeItem(k) { this.m.delete(String(k)); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
}

/* ---------- indexedDB (минимум, нужный приложению) ---------- */
export class FakeIDB {
  constructor() { this.dbs = new Map(); this.failOpen = false; this.failPut = false; this.hang = false; this.hangTx = false; this.available = true; this.opens = 0; }
  open(name /*, ver */) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    REAL.setTimeout(() => {
      this.opens++;
      if (this.hang) return;                                          // открытие «зависло»: ни onsuccess, ни onerror
      if (this.failOpen) { req.error = new Error('open failed'); req.onerror && req.onerror({ target: req }); return; }
      let rec = this.dbs.get(name); const fresh = !rec;
      if (fresh) { rec = { stores: new Map(), keyPaths: new Map() }; this.dbs.set(name, rec); }
      const db = {
        objectStoreNames: { contains: n => rec.stores.has(n) },
        createObjectStore: (n, o) => { rec.stores.set(n, new Map()); rec.keyPaths.set(n, (o && o.keyPath) || 'id'); return {}; },
        transaction: (n, mode) => new FakeTx(this, rec, n, mode),
      };
      req.result = db;
      if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
      req.onsuccess && req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}
class FakeTx {
  constructor(idb, rec, storeName, mode) {
    this.idb = idb; this.rec = rec; this.storeName = storeName; this.mode = mode; this.error = null;
    this.oncomplete = null; this.onerror = null; this.onabort = null; this.ops = [];
    REAL.setTimeout(() => this.run(), 0);                          // макро-задача: к этому моменту все put/getAll уже поставлены в очередь
  }
  objectStore() {
    const tx = this, data = this.rec.stores.get(this.storeName), kp = this.rec.keyPaths.get(this.storeName);
    const op = fn => { const req = { result: undefined, error: null, onsuccess: null, onerror: null }; tx.ops.push({ req, fn }); return req; };
    return {
      put: v => op(stage => { if (tx.idb.failPut) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } stage.set(v[kp], structuredClone(v)); return v[kp]; }),
      getAll: () => op(stage => [...stage.values()].map(x => structuredClone(x))),
      delete: k => op(stage => { stage.delete(k); }),
      get: k => op(stage => structuredClone(stage.get(k))),
    };
  }
  run() {
    if (this.idb.hangTx && this.mode === 'readwrite') return;         // транзакция записи «зависла»: ни oncomplete, ни onabort (чтение работает)
    const data = this.rec.stores.get(this.storeName), stage = new Map(data);
    for (const { req, fn } of this.ops) {
      try { req.result = fn(stage); req.onsuccess && req.onsuccess({ target: req }); }
      catch (e) { req.error = e; this.error = e; req.onerror && req.onerror({ target: req }); this.onabort && this.onabort({ target: this }); return; }   // abort: изменения не фиксируются
    }
    if (this.mode === 'readwrite') this.rec.stores.set(this.storeName, stage);
    this.oncomplete && this.oncomplete({ target: this });
  }
}

/* ---------- GitHub Gist API (общий «сервер» для нескольких устройств) ---------- */
export class GistServer {
  constructor() { this.gists = new Map(); this.nextId = 1; this.offline = false; this.hang = false; this.failMethods = new Set(); this.status = null; this.log = []; this.token = 'ghp_test_token'; }
  files(id) { return this.gists.get(id).files; }
  content(id) { id = id || [...this.gists.keys()][0]; const f = id && this.gists.get(id).files['konverty_state.json']; return f ? f.content : null; }
  setContent(id, text) { id = id || [...this.gists.keys()][0]; this.gists.get(id).files['konverty_state.json'] = { content: text }; }
  res(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; }
  async fetch(url, opts) {
    opts = opts || {}; const method = (opts.method || 'GET').toUpperCase();
    this.log.push(method + ' ' + String(url).replace('https://api.github.com', ''));
    if (this.offline || this.failMethods.has(method)) throw new TypeError('Failed to fetch');   // сеть пропала целиком либо только для этого HTTP-метода
    if (String(url).startsWith('https://open.er-api.com/')) return this.res(200, { result: 'success', rates: this.rates || {} });   // сервис курсов валют (updateRates)
    if (this.hang) await new Promise((_, rej) => {                                              // сервер «завис»: ответа нет, пока запрос не оборвут по таймауту (AbortSignal)
      const abort = () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (opts.signal) { if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort); } });
    if (this.status) return this.res(this.status, { message: 'forced' });
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    if (auth !== 'Bearer ' + this.token) return this.res(401, { message: 'Bad credentials' });
    const path = String(url).replace('https://api.github.com', '');
    if (method === 'GET' && path.startsWith('/gists?')) return this.res(200, [...this.gists.entries()].map(([id, g]) => ({ id, files: Object.fromEntries(Object.keys(g.files).map(n => [n, {}])) })));
    if (method === 'POST' && path === '/gists') {
      const b = JSON.parse(opts.body), id = 'g' + (this.nextId++); this.gists.set(id, { files: JSON.parse(JSON.stringify(b.files)) });
      return this.res(201, { id });
    }
    const m = /^\/gists\/([\w-]+)$/.exec(path);
    if (m && this.gists.has(m[1])) {
      const g = this.gists.get(m[1]);
      if (method === 'GET') return this.res(200, { id: m[1], files: JSON.parse(JSON.stringify(g.files)) });
      if (method === 'PATCH') { Object.assign(g.files, JSON.parse(opts.body).files); return this.res(200, { id: m[1] }); }
    }
    return this.res(404, { message: 'Not Found' });
  }
}

/* ---------- Часы: монотонные, управляемые ---------- */
export class Clock {
  constructor(t0) { this.t = t0 || Date.UTC(2026, 10, 4, 10, 0, 0); }
  now() { return ++this.t; }
  advance(ms) { this.t += ms; }
}

/* ---------- Загрузка исходников ---------- */
const ROOT = new URL('./', import.meta.url);
const read = f => readFileSync(new URL(f, ROOT), 'utf8');
function mainScriptOf(html) {
  const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return all[all.length - 1];                                       // основной скрипт — последний inline-блок
}
let SRC = null;
function sources() {
  if (SRC) return SRC;
  const core = read('core.js'), main = mainScriptOf(read('index.html'));
  const cut = main.indexOf("setTimeout(()=>{ const s=document.getElementById('splash')");   // начало загрузочного блока
  if (cut < 0) throw new Error('harness: не найден загрузочный блок index.html (splash) — обнови app.harness.js');
  const boot = main.slice(cut);
  if (!/applyTheme\(\); load\(\); loadOpsFilter\(\);/.test(boot)) throw new Error('harness: в загрузочном блоке нет «applyTheme(); load(); loadOpsFilter();»');
  const snapshot = /try\{ const _t=todayISO\(\); state\.rateHistory \|\|= \{\};[^\n]*?\}catch\(e\)\{\}/.exec(boot);
  if (!snapshot) throw new Error('harness: не найден ежедневный снимок курсов в загрузочном блоке — обнови app.harness.js');
  SRC = { core, app: main.slice(0, cut), snapshot: snapshot[0] };
  return SRC;
}

/* ---------- Устройство (одна «вкладка приложения») ---------- */
export function createDevice(name, opts) {
  opts = opts || {};
  const { core, app, snapshot } = sources();
  const D = {
    name, ls: opts.ls || new FakeStorage(), idb: opts.idb || new FakeIDB(), server: opts.server || new GistServer(),
    clock: opts.clock || new Clock(), toasts: [], confirms: [], renders: 0, timers: [], timerSeq: 1, dom: new Map(), readers: [],
    confirmAnswer: () => true,
  };
  const U = makeStub();
  const self = { get indexedDB() { return D.idb.available ? D.idb : undefined; } };
  const documentFake = new Proxy({}, { get: (_, p) => p === 'getElementById' ? (id => (D.dom.has(id) ? D.dom.get(id) : U)) : U, set: () => true });
  const DateX = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(D.clock.now()); }
    static now() { return D.clock.now(); }
  };
  const fakeSetTimeout = (fn, ms) => { const id = D.timerSeq++; D.timers.push({ id, fn, ms: ms || 0 }); return id; };
  const fakeClearTimeout = id => { D.timers = D.timers.filter(t => t.id !== id); };
  class FakeFileReader { readAsText(file) { D.readers.push(this); this.done = (async () => { await tick0(); this.result = file.text; if (this.onload) await this.onload(); })(); } }
  const env = {
    document: documentFake, window: U, navigator: { onLine: true, vibrate() {}, storage: undefined }, localStorage: D.ls, sessionStorage: new FakeStorage(),
    fetch: (url, o) => D.server.fetch(url, o), setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, setInterval: () => 0, clearInterval: () => {},
    FileReader: FakeFileReader, Date: DateX, self, indexedDB: { open: (...a) => D.idb.open(...a) }, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    event: null,                                                      // window.event: syncConnectUI читает event.target (на кнопку из теста клика нет)
    Notification: undefined, requestAnimationFrame: fn => fakeSetTimeout(fn, 16), Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  };
  const names = Object.keys(env);
  const body = `"use strict";
const { ${names.join(', ')} } = __env;
${core}
${app}
// ---- эпилог стенда: наблюдаемые подмены UI ----
toast = m => { __D.toasts.push(String(m)); };
confirmSheet = (msg, o) => { __D.confirms.push(String(msg)); return Promise.resolve(__D.confirmAnswer(String(msg), o)); };
__D.real = { render, renderMore, renderAccounts, renderOps };    // настоящие экранные функции — для проверок разметки (D.real.renderMore() рисует в элемент screen-more из D.dom)
render = () => { __D.renders++; }; renderMore = () => { __D.renders++; }; closeSheet = () => {}; openSheet = () => {}; showSheetShell = () => {}; haptic = () => {};
const __dailySnapshot = () => { ${snapshot} };
return { $: (src, arg) => eval(src), dailySnapshot: __dailySnapshot };`;
  const prevCore = globalThis.KonvertyCore;                          // core.js в конце ставит globalThis.KonvertyCore — не даём устройству затирать общий
  let api;
  try { api = new Function('__env', '__D', body)(env, D); }
  finally { globalThis.KonvertyCore = prevCore; }
  D.$ = api.$;
  D.state = () => D.$('state');
  D.call = (fn, ...args) => D.$(`${fn}(...arg)`, args);              // вызов функции приложения по имени
  /** Выполнить отложенные таймеры (save → запись, maybeAutoBackup, syncPushDebounced …). Повторно, пока очередь не пуста (но не бесконечно). */
  // По умолчанию выполняет только «рабочие» таймеры (save 50 мс, отложенная синхронизация 2,5 с, повтор 4 с …); «сторожевые» (обрыв запроса 25 с,
  // таймаут замка 60 с) пропускает — иначе flush сам отменил бы ожидающее восстановление. Их запускает D.fireWatchdogs().
  D.flush = async (rounds = 6, maxMs = 10000) => { for (let i = 0; i < rounds; i++) { const q = D.timers.filter(t => t.ms <= maxMs); if (!q.length) break; D.timers = D.timers.filter(t => t.ms > maxMs);
    for (const t of q) { try { await t.fn(); } catch (e) { D.errors = (D.errors || []).concat(String(e)); } } await tick0(); } await tick0(); };
  D.fireWatchdogs = async (pred = t => t.ms > 10000) => { const q = D.timers.filter(pred); D.timers = D.timers.filter(t => !pred(t)); for (const t of q) { try { await t.fn(); } catch (e) { D.errors = (D.errors || []).concat(String(e)); } } await tick0(); };
  /** Вклиниться в ближайший ответ облака на pull (GET /gists/<id>) — то есть в ожидание сети внутри runSync. hook может быть async. */
  D.onNextPull = hook => { const orig = D.server.fetch.bind(D.server); D.server.fetch = async (url, o) => { const path = String(url).replace('https://api.github.com', ''); if ((!o || !o.method || o.method === 'GET') && /^\/gists\/g\d+$/.test(path)) { D.server.fetch = orig; await hook(); } return orig(url, o); }; };
  /** Вклиниться сразу ПОСЛЕ завершения следующей копии с причиной reasonRe (окно между копией и записью состояния). */
  D.afterNextBackup = (reasonRe, hook) => { const orig = D.$('createBackup'); D.$('createBackup = arg', async reason => { const r = await orig(reason); if (reasonRe.test(reason)) { D.$('createBackup = arg', orig); await hook(); } return r; }); };
  D.settle = async () => { for (let i = 0; i < 5; i++) await tick0(); };
  /** Загрузка приложения как при старте страницы: load() + ежедневный снимок курсов (строка берётся из реального загрузочного блока). */
  D.boot = async () => { D.$('load()'); api.dailySnapshot(); await D.flush(); };
  /** Перезапуск: новое устройство-экземпляр на тех же хранилищах (как перезагрузка страницы). */
  D.reload = () => createDevice(name, { ls: D.ls, idb: D.idb, server: D.server, clock: D.clock });
  D.setInputs = obj => { for (const k in obj) D.dom.set(k, obj[k]); };   // поля форм: { 'acc-name': {value:'X'}, 'acc-inv': {checked:false}, … }
  D.lastToast = () => D.toasts[D.toasts.length - 1];
  D.toastMatch = re => D.toasts.some(t => re.test(t));
  D.importFile = async text => { const ev = { target: { files: [{ text }], value: 'x' } }; D.call('importData', ev); await Promise.all(D.readers.map(r => r.done)); await D.settle(); };
  return D;
}
