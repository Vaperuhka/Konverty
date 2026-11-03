/* =====================================================================
   core.js — ЧИСТОЕ ДЕНЕЖНОЕ ЯДРО приложения «Конверты».
   Валюты/курсы, балансы (счета + конверты + «долг конвертам»), распределение дохода.
   Вынесено из index.html (0.19.0), чтобы:
     1) быть единым источником правды для расчётов, и
     2) тестироваться в tests.html без DOM (браузерный прогон).
   Классический (не-module) скрипт: верхнеуровневые объявления попадают в общий
   глобальный scope страницы и видны из index.html. Код НЕ трогает DOM.
   Зависит от глобалей, объявленных в index.html (или в фикстуре tests.html):
     • state — объект данных приложения;
     • dataStamp, _balCache, _balCacheAt — для мемоизации computeBalances().
   Логика идентична прежней встроенной версии — при правке держать синхронно с tests.html.
   ===================================================================== */
"use strict";

/* ---------- Деньги / валюты ---------- */
const cur = code => state.currencies.find(c=>c.code===code) || {code,symbol:code,rate:1};
const round2 = n => Math.round((n+Number.EPSILON)*100)/100;
function fmt(amount, code) { const c=cur(code); const n=round2(amount);
  return `${n.toLocaleString('ru-RU',{minimumFractionDigits:(n%1?2:0),maximumFractionDigits:2})} ${c.symbol}`; }
const toBase = (amount,code) => amount * cur(code).rate;
// Исторические курсы: курс валюты (база за 1 единицу) на дату — по ближайшему снимку ≤ даты, иначе текущий.
function rateAt(code, date){ if(code===state.baseCurrency) return 1; const h=state.rateHistory||{}; let best=null;
  for(const d in h){ if(d<=date && (best===null||d>best)) best=d; }
  if(best!==null && h[best] && h[best][code]>0) return h[best][code];
  const c=cur(code); return (c&&c.rate)||1; }
const toBaseAt = (amount, code, date) => amount * rateAt(code, date);
const fmtBase = amount => fmt(amount, state.baseCurrency);
// Перевод суммы из одной валюты в другую по заданным курсам
const convert = (amount, from, to) => from===to ? round2(amount) : round2(amount * cur(from).rate / cur(to).rate);
// Как convert, но по ИСТОРИЧЕСКОМУ курсу на дату (через базу): движение по счёту от долга/возврата не должно «плавать» с текущим курсом.
const convertAt = (amount, from, to, date) => from===to ? round2(amount) : round2(amount * rateAt(from,date) / rateAt(to,date));
const accCur = id => acc(id)?.currency || state.baseCurrency;

const acc = id => state.accounts.find(a=>a.id===id);
const env = id => state.envelopes.find(e=>e.id===id);
const catById = id => state.categories.find(c=>c.id===id);
// Части расхода по категориям/конвертам: split-операция даёт свои части, обычная — одну.
const txParts = t => (t.type==='expense' && Array.isArray(t.splits) && t.splits.length) ? t.splits : [{categoryId:t.categoryId, envelopeId:t.envelopeId, amount:t.amount}];
const activeAccounts = () => state.accounts.filter(a=>!a.archived);
const spendableAccounts = () => activeAccounts().filter(a=>!a.investment && !a.excluded);
const investmentAccounts = () => activeAccounts().filter(a=>a.investment);
const activeEnvelopes = () => state.envelopes.filter(e=>!e.archived);

/* ---------- Балансы ---------- */
function _computeBalances() {
  const envBal={}, accBal={}, owedBal={};
  state.envelopes.forEach(e=>{ envBal[e.id]={}; owedBal[e.id]={}; }); state.accounts.forEach(a=>accBal[a.id]={});
  const addEnv=(id,c,delta)=>{ (envBal[id] ||= {}); envBal[id][c]=round2((envBal[id][c]||0)+delta); };
  const addAcc=(id,c,delta)=>{ (accBal[id] ||= {}); accBal[id][c]=round2((accBal[id][c]||0)+delta); };
  const addOwed=(id,c,delta)=>{ (owedBal[id] ||= {}); owedBal[id][c]=round2((owedBal[id][c]||0)+delta); };
  for (const t of state.transactions) {
    if (t.type==='income') {
      // accountCredits: {id:{amt,cur}} (новый формат) или {id:число} (старый)
      if (t.accountCredits) for (const [id,cr] of Object.entries(t.accountCredits)) {
        if (typeof cr==='number') addAcc(id,t.currency,cr); else addAcc(id,cr.cur,cr.amt);
      }
      if (t.distribution) for (const [id,amt] of Object.entries(t.distribution)) addEnv(id,t.currency,amt);
      // Долг конвертам = запланировано (plan) минус фактически оплачено (distribution)
      if (t.plan) for (const [id,p] of Object.entries(t.plan)) {
        const d=(t.distribution&&t.distribution[id])||0, short=round2(p-d);
        if (Math.abs(short)>0.005) addOwed(id,t.currency,short);
      }
    } else if (t.type==='expense') {
      if (t.accountId) addAcc(t.accountId,t.currency,-t.amount);
      if (Array.isArray(t.splits) && t.splits.length) { for(const s of t.splits){ if(s.envelopeId) addEnv(s.envelopeId,t.currency,-s.amount); } }
      else if (t.envelopeId) addEnv(t.envelopeId,t.currency,-t.amount);
    } else if (t.type==='transfer') {
      if (t.fromAmount!=null) { addAcc(t.fromAccountId,t.fromCurrency,-t.fromAmount); addAcc(t.toAccountId,t.toCurrency,t.toAmount); }
      else { addAcc(t.fromAccountId,t.currency,-t.amount); addAcc(t.toAccountId,t.currency,t.amount); }
    } else if (t.type==='envtransfer') {
      addEnv(t.fromEnvelopeId,t.currency,-t.amount); addEnv(t.toEnvelopeId,t.currency,t.amount);
    } else if (t.type==='envfund') {
      // Пополнение/возврат конверта из свободных денег (счета не трогаем). Бюджет конверта двигается на amount.
      // Долг («нужно доложить») гасится ТОЛЬКО пополнением (+) и только до нуля; возврат (−) долг не создаёт.
      addEnv(t.envelopeId,t.currency,t.amount);
      if (t.amount>0.005){ const cur=(owedBal[t.envelopeId]||{})[t.currency]||0; if(cur>0.005) addOwed(t.envelopeId,t.currency,-Math.min(cur,t.amount)); }
    } else if (t.type==='adjust') {
      // Корректировка баланса счёта (разница до нужной суммы), конверты не трогаем
      addAcc(t.accountId,t.currency,t.amount);
    } else if (t.type==='envadjust') {
      // Корректировка суммы в конверте (счета не трогаем). Пополнение (+) гасит долг конверта до нуля, как envfund.
      addEnv(t.envelopeId,t.currency,t.amount);
      if (t.amount>0.005){ const cur=(owedBal[t.envelopeId]||{})[t.currency]||0; if(cur>0.005) addOwed(t.envelopeId,t.currency,-Math.min(cur,t.amount)); }
    }
  }
  // Долги, привязанные к счёту: тело долга и возвраты реально двигают деньги на счёте.
  // Это НЕ доход/расход (в аналитику не попадает) и конверты не трогает — только баланс счёта.
  for (const d of state.debts) {
    if (!d.accountId || !acc(d.accountId)) continue;
    const sign = d.direction==='iowe' ? 1 : -1;   // мне дали в долг → +на счёт; я дал в долг → −со счёта
    addAcc(d.accountId, accCur(d.accountId), sign * convertAt(d.amount, d.currency, accCur(d.accountId), d.date));
    for (const p of (d.payments||[])) {
      const pa = (p.accountId && acc(p.accountId)) ? p.accountId : d.accountId;
      addAcc(pa, accCur(pa), -sign * convertAt(p.amount, d.currency, accCur(pa), p.date||d.date));   // возврат — по курсу на дату платежа
    }
  }
  return { envBal, accBal, owedBal };
}
// Мемоизация: пересчитываем балансы только когда данные менялись (save/import/reset двигают dataStamp).
function computeBalances(){ if(_balCache && _balCacheAt===dataStamp) return _balCache; _balCache=_computeBalances(); _balCacheAt=dataStamp; return _balCache; }
const sumBase = m => Object.entries(m||{}).reduce((s,[c,a])=>s+toBase(a,c),0);
const accountBase = (accBal,id) => sumBase(accBal[id]);
const envelopeBase = (envBal,id) => sumBase(envBal[id]);
const owedBase = (owedBal,id) => sumBase(owedBal[id]);
const totalNet = accBal => state.accounts.filter(a=>!a.excluded).reduce((s,a)=>s+accountBase(accBal,a.id),0);
const spendableTotal = accBal => spendableAccounts().reduce((s,a)=>s+accountBase(accBal,a.id),0);
const envelopesTotal = envBal => state.envelopes.reduce((s,e)=>s+envelopeBase(envBal,e.id),0);
const totalOwed = owedBal => state.envelopes.reduce((s,e)=>s+(e.noOwe?0:Math.max(0,owedBase(owedBal,e.id))),0);
// Пункт 5: деньги, отложенные в цели-накопления (в базовой валюте) — реально резервируются из свободных.
// M2: привязанные к конверту цели НЕ вычитаем повторно — их деньги уже в конверте (committedEnvelopes).
const goalsReservedBase = () => (state.goals||[]).filter(g=>!g.archived && !(g.envelopeId&&env(g.envelopeId))).reduce((s,g)=>s+toBase(g.saved||0, g.currency||state.baseCurrency),0);
// H1/M3: закреплено в конвертах = сумма ТОЛЬКО положительных бюджетов (перерасход не считается «занятым», иначе минус конверта раздувал бы «Свободно»).
const committedEnvelopes = envBal => state.envelopes.reduce((s,e)=>s+Math.max(0, envelopeBase(envBal,e.id)),0);
// Единый источник «Свободно»: тратимые деньги − закреплённое в конвертах − резерв целей.
const freeMoney = (accBal, envBal) => round2(spendableTotal(accBal) - committedEnvelopes(envBal) - goalsReservedBase());
// «Не разложено по конвертам» (для уведомления на «Счета» и определения перекоса): без вычета целей.
const unallocated = (accBal, envBal) => round2(spendableTotal(accBal) - committedEnvelopes(envBal));
// Target: сколько РЕАЛЬНО пополнено в конверт за месяц ym (в базовой валюте) — учитываются все каналы пополнения,
// кроме трат: распределение дохода (funded-часть), envfund, envtransfer (вход − выход), envadjust. Расходы прогресс не уменьшают.
// Потрачено из конверта за месяц (в базовой валюте) — расходы, привязанные к конверту, включая части split.
function envSpentInMonth(envId, ym){ let s=0;
  for(const t of state.transactions){ if(t.type!=='expense'||(t.date||'').slice(0,7)!==ym) continue;
    for(const p of txParts(t)){ if(p.envelopeId===envId) s+=toBase(p.amount, t.currency); } }
  return round2(s); }
function envFundedInMonth(envId, ym){ let s=0;
  for(const t of state.transactions){ if((t.date||'').slice(0,7)!==ym) continue;
    if(t.type==='income'){ if(t.distribution && t.distribution[envId]) s+=toBase(t.distribution[envId], t.currency); }
    else if(t.type==='envfund'){ if(t.envelopeId===envId) s+=toBase(t.amount, t.currency); }
    else if(t.type==='envadjust'){ if(t.envelopeId===envId) s+=toBase(t.amount, t.currency); }
    else if(t.type==='envtransfer'){ if(t.toEnvelopeId===envId) s+=toBase(t.amount,t.currency); if(t.fromEnvelopeId===envId) s-=toBase(t.amount,t.currency); }
  }
  return round2(s); }
// Этап 3: средний дневной расход за последние N дней (в базовой валюте).
function avgDailySpendBase(days){ days=days||90; const c=new Date(); c.setDate(c.getDate()-days);
  const cutISO=`${c.getFullYear()}-${String(c.getMonth()+1).padStart(2,'0')}-${String(c.getDate()).padStart(2,'0')}`;
  const sum=state.transactions.filter(t=>t.type==='expense'&&t.date>=cutISO).reduce((s,t)=>s+toBase(t.amount,t.currency),0);
  return sum>0? round2(sum/days) : 0; }

/* ---------- Распределение дохода ---------- */
function distribute(amount) {
  const act = activeEnvelopes(); const dist={};
  const totalW = act.reduce((s,e)=>s+(e.percent||0),0);
  if (totalW>0 && act.length) {
    let a=0;
    act.forEach((e,i)=>{ let v = i===act.length-1 ? round2(amount-a) : round2(amount*(e.percent||0)/totalW); if(i<act.length-1) a=round2(a+v); dist[e.id]=v; });
    // Защита от отрицательной доли последнего конверта при суб-копеечном округлении: недостачу гасим из самой большой доли (сумма долей остаётся == amount).
    const lastId=act[act.length-1].id;
    if(dist[lastId]<0){ const need=round2(-dist[lastId]); dist[lastId]=0; let bigId=act[0].id; for(const e of act) if(dist[e.id]>dist[bigId]) bigId=e.id; dist[bigId]=round2(dist[bigId]-need); }
  } else if (act.length) dist[act[0].id]=round2(amount);
  return dist;
}
// Доход: off-top на инвест-счета, остаток на выбранный счёт + распределение по конвертам
function computeIncome(amount, mainAccountId) {
  const main = acc(mainAccountId);
  const mainCur = main?.currency || state.baseCurrency;
  if (main && main.investment) {
    // Прямое пополнение инвест-счёта (например проценты Binance) — без off-top и без конвертов
    return { accountCredits:{[mainAccountId]:{amt:round2(amount),cur:mainCur}}, distribution:{}, distCurrency:mainCur, remainder:0, offTop:{}, mainCur };
  }
  // Доход в валюте основного счёта. Off-top на инвест-счета — с конвертацией в их валюту.
  const offTop={}; let offSumMain=0;
  investmentAccounts().forEach(a=>{ if(a.offTopPercent>0 && !a.excluded){
    const amtMain = round2(amount*a.offTopPercent/100);          // в валюте дохода
    offTop[a.id] = { amtMain, amt: convert(amtMain, mainCur, a.currency), cur: a.currency };
    offSumMain += amtMain;
  }});
  // Защита: суммарный off-top не может превышать доход (несколько инвест-счетов >100%) — масштабируем вниз.
  if (offSumMain>amount && offSumMain>0){ const k=amount/offSumMain; let s=0;
    for (const o of Object.values(offTop)){ o.amtMain=round2(o.amtMain*k); o.amt=convert(o.amtMain, mainCur, o.cur); s+=o.amtMain; }
    offSumMain=round2(s);   // фактическая сумма после округления; копеечный хвост уйдёт в remainder (на основной счёт), не потеряется
  }
  const remainder = round2(Math.max(0, amount - offSumMain));    // в валюте дохода
  const accountCredits = {};
  for (const [id,o] of Object.entries(offTop)) accountCredits[id] = { amt:o.amt, cur:o.cur };
  accountCredits[mainAccountId] = { amt:remainder, cur:mainCur };
  return { accountCredits, distribution: distribute(remainder), distCurrency:mainCur, remainder, offTop, mainCur };
}

/* ---------- Синхронизация: слияние состояний ---------- */
// Чистая функция трёхстороннего слияния (used by syncNow). Объединяет коллекции по id,
// конфликты одного id разрешает в пользу стороны с бОльшим rev, удаления уважает через tombstones.
// Скаляры/настройки берутся со стороны с бОльшим rev. Детерминирована → тестируется в Deno.
function mergeStates(local, remote){
  if(!remote || typeof remote!=='object') return local;
  if(!local  || typeof local!=='object')  return remote;
  const lRev=+local.rev||0, rRev=+remote.rev||0;
  const newer = lRev>=rRev ? local  : remote;
  const older = lRev>=rRev ? remote : local;
  const out = Object.assign({}, newer);               // скаляры/настройки — со стороны с бОльшим rev
  // Объединяем «надгробия» удалений: по каждому id — максимальная метка времени
  const tomb = Object.assign({}, older.tombstones||{});
  const nt = newer.tombstones||{};
  for(const id in nt){ if(!(id in tomb) || nt[id]>tomb[id]) tomb[id]=nt[id]; }
  out.tombstones = tomb;
  // Коллекции по id: объединение (newer перезаписывает конфликт), удалённые (в tomb) исключаем
  const COLLS=['transactions','accounts','envelopes','categories','debts','recurring','goals','events','watchlists','templates'];
  for(const coll of COLLS){
    const map=new Map();
    for(const it of (older[coll]||[])) if(it && it.id!=null) map.set(String(it.id), it);
    for(const it of (newer[coll]||[])) if(it && it.id!=null) map.set(String(it.id), it);
    out[coll] = [...map.values()].filter(it => !(String(it.id) in tomb));
  }
  // Валюты — объединяем по коду (newer выигрывает конфликт); rateHistory — объединяем снимки по дате (newer выигрывает ту же дату).
  { const cm=new Map();
    for(const c of (older.currencies||[])) if(c&&c.code) cm.set(c.code,c);
    for(const c of (newer.currencies||[])) if(c&&c.code) cm.set(c.code,c);
    if(cm.size) out.currencies=[...cm.values()]; }
  out.rateHistory = Object.assign({}, older.rateHistory||{}, newer.rateHistory||{});
  out.rev = Math.max(lRev, rRev);
  return out;
}

// Решение синхронизации по ревизиям (чистое, тестируется интеграционным стендом): что делать.
// base — ревизия, которая на момент прошлой синхронизации была и локально, и в облаке.
function syncDecide(localRev, remoteRev, base, hasRemote){
  if(!hasRemote) return 'push';                              // облака нет/пустое → выгрузить локальное
  if(localRev===base && remoteRev!==base) return 'adopt';    // менялось только облако → загрузить
  if(remoteRev===base && localRev!==base) return 'push';     // менялось только локально → выгрузить
  if(localRev===base && remoteRev===base) return 'noop';     // никто не менялся
  return 'merge';                                            // менялись обе стороны → слить
}

// Санитайз id всех сущностей (импорт/синк могут принести id со спецсимволами → инъекция в onclick/атрибуты).
// Приводим к безопасному набору [A-Za-z0-9_-], согласованно обновляя ВСЕ ссылки. Для чистых данных (uid=base36) — no-op.
function sanitizeIds(state, uidFn){
  const safe = s => String(s==null?'':s).replace(/[^A-Za-z0-9_-]/g,'');
  const remap={}, used=new Set();
  const colls=['accounts','envelopes','categories','transactions','debts','recurring','goals','events','watchlists','templates'];
  for(const coll of colls){ for(const it of (state[coll]||[])){ if(!it || it.id==null) continue; const id=String(it.id);
    let ns=safe(id) || (uidFn?uidFn():'id'+Math.random().toString(36).slice(2,8));
    if(ns!==id || used.has(ns)){ while(used.has(ns)) ns=ns+'x'+Math.floor(Math.random()*1679616).toString(36); if(ns!==id) remap[id]=ns; it.id=ns; }
    used.add(it.id); } }
  if(!Object.keys(remap).length) return state;   // чистые данные — ничего не меняли
  const rm=v=>(v!=null && remap[String(v)]!=null)?remap[String(v)]:v;
  const rk=o=>{ if(!o||typeof o!=='object') return o; const n={}; for(const k in o) n[rm(k)]=o[k]; return n; };
  for(const t of (state.transactions||[])){ t.accountId=rm(t.accountId); t.fromAccountId=rm(t.fromAccountId); t.toAccountId=rm(t.toAccountId);
    t.envelopeId=rm(t.envelopeId); t.fromEnvelopeId=rm(t.fromEnvelopeId); t.toEnvelopeId=rm(t.toEnvelopeId); t.categoryId=rm(t.categoryId);
    if(Array.isArray(t.splits)) t.splits.forEach(s=>{ s.envelopeId=rm(s.envelopeId); s.categoryId=rm(s.categoryId); });
    t.distribution=rk(t.distribution); t.plan=rk(t.plan); t.accountCredits=rk(t.accountCredits); }
  for(const d of (state.debts||[])){ d.accountId=rm(d.accountId); (d.payments||[]).forEach(p=>{ p.accountId=rm(p.accountId); }); }
  for(const r of (state.recurring||[])){ r.accountId=rm(r.accountId); r.categoryId=rm(r.categoryId); }
  for(const g of (state.goals||[])){ g.envelopeId=rm(g.envelopeId); }
  for(const ev of (state.events||[])){ ev.envelopeId=rm(ev.envelopeId); }
  for(const w of (state.watchlists||[])){ if(w && w.type==='category') w.value=rm(w.value); }
  return state;
}

/* ---------- Отчёты за период ---------- */
// Сводка за период [fromYm..toYm] включительно (строки 'YYYY-MM'): доходы/расходы/нетто
// и разбивка по категориям, в базовой валюте по ИСТОРИЧЕСКОМУ курсу (как «Анализ»). split учитывается по частям.
function periodReport(fromYm, toYm){
  let income=0, expense=0; const expByCat={}, incByCat={};
  for(const t of state.transactions){
    if(t.hidden) continue;
    const ym=(t.date||'').slice(0,7); if(ym<fromYm || ym>toYm) continue;
    if(t.type==='income'){ const v=toBaseAt(t.amount, t.currency, t.date); income+=v; const k=t.categoryId||'__none__'; incByCat[k]=round2((incByCat[k]||0)+v); }
    else if(t.type==='expense'){ for(const p of txParts(t)){ const v=toBaseAt(p.amount, t.currency, t.date); expense+=v; const k=p.categoryId||'__none__'; expByCat[k]=round2((expByCat[k]||0)+v); } }
  }
  return { income:round2(income), expense:round2(expense), net:round2(income-expense), expByCat, incByCat };
}

/* ---------- Импорт CSV: ключ дедупликации (пункт 3.13) ---------- */
// Учитывает счёт и валюту: один и тот же чек, импортированный на РАЗНЫЕ счета/в разных валютах, больше не считается дублем.
function csvDedupKey(date, amt, note, isInc, acctId, curc){
  return `${date}|${round2(amt)}|${String(note||'').trim().toLowerCase()}|${isInc?'i':'e'}|${acctId||''}|${curc||''}`;
}

/* ---------- Проверка целостности состояния (пункт P0.1) ---------- */
// Строгая схема: не принимаем пустой объект/null/массив/битый JSON как состояние приложения
// (иначе облако «{}» или повреждённый gist затёр бы локальную историю через normalize()).
function isValidState(s){
  if(!s || typeof s!=='object' || Array.isArray(s)) return false;
  if(typeof s.baseCurrency!=='string' || !s.baseCurrency) return false;
  if(!Array.isArray(s.currencies) || !s.currencies.length) return false;
  for(const k of ['transactions','accounts','envelopes','categories']){ if(!Array.isArray(s[k])) return false; }
  // Углублённая проверка (P0): валюты — непустой code + конечный положительный rate; базовая валюта обязана присутствовать.
  const codes=new Set();
  for(const c of s.currencies){ if(!c || typeof c.code!=='string' || !c.code) return false;
    if(!(typeof c.rate==='number' && isFinite(c.rate) && c.rate>0)) return false; codes.add(c.code); }
  if(!codes.has(s.baseCurrency)) return false;
  // Справочники — объекты с непустым id.
  for(const k of ['accounts','envelopes','categories']){ for(const it of s[k]){ if(!it || typeof it!=='object' || it.id==null || String(it.id)==='') return false; } }
  // Транзакции — объект с непустым id, известным типом и конечной суммой (если задана).
  const TYPES=new Set(['income','expense','transfer','envtransfer','envfund','adjust','envadjust']);
  for(const t of s.transactions){ if(!t || typeof t!=='object' || t.id==null) return false; if(!TYPES.has(t.type)) return false;
    if(t.amount!=null && !(typeof t.amount==='number' && isFinite(t.amount))) return false; }
  return true;
}

/* ---------- SMS-парсер суммы (пункты 3.4 / P1.1) ---------- */
// Берём сумму ОПЕРАЦИИ (покупки/списания), а не остаток/доступно. Сначала вырезаем даты/время/маски карт,
// чтобы их цифры не слиплись с суммой (напр. «2026-11-03 4 500 KZT» не должно давать 34500).
function smsAmount(text){
  let s=String(text).replace(/ /g,' ');
  s=s.replace(/\d{4}-\d{2}-\d{2}/g,' ')                 // ISO-дата 2026-11-03
     .replace(/\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/g,' ')    // дата 03.11.2026 / 03/11/26
     .replace(/\d{1,2}:\d{2}(?::\d{2})?/g,' ')           // время 18:32[:00]
     .replace(/\*+\d+|\d+\*+/g,' ');                     // маски карт *1234 / 1234*
  const BAL=/(доступн|остаток|бала?нс|dostupno|available|balance|ostatok)/i;
  const OP=/(покупк|списан|оплат|снят|расход|перевод|pokupka|oplata|spisanie|perevod|withdraw|debit|payment)/i;
  const re=/(\d[\d\s]{0,12}(?:[.,]\d{1,2})?)\s*(₸|тг|тнг|тенге|руб|₽|грн|₴|\$|usd|eur|€|kzt|rub|uah)/gi;
  let m; const hits=[];
  while((m=re.exec(s))){ const n=parseFloat(m[1].replace(/\s/g,'').replace(',','.')); if(isNaN(n)) continue;
    const before=s.slice(Math.max(0,m.index-24), m.index); hits.push({n, bal:BAL.test(before), op:OP.test(before)}); }
  if(hits.length){ const pool=hits.filter(h=>!h.bal).length?hits.filter(h=>!h.bal):hits;   // сначала отбрасываем «остаток/доступно»
    const near=pool.filter(h=>h.op);                                                      // предпочитаем число рядом со словом операции
    return round2((near.length?near[0]:pool[0]).n); }
  // запасной вариант — самое большое число, не являющееся маской карты (*1234)
  const nums=[]; let mm; const re2=/(^|[^\d*])(\d[\d\s]{0,12}(?:[.,]\d{1,2})?)/g;
  while((mm=re2.exec(s))){ const n=parseFloat(mm[2].replace(/\s/g,'').replace(',','.')); if(!isNaN(n)) nums.push(n); }
  return nums.length? round2(Math.max(...nums)) : null;
}

// Единое пространство функций ядра. Выставляем ВСЕГДА (и в Deno/Node, и в браузере) — так и tests.html,
// и core.test.js берут ОДИН и тот же набор (пункт P1.7: раньше tests.html собирал C вручную и отставал).
// В приложении это просто дополнительный глобальный объект-ссылка, на логику не влияет.
globalThis.KonvertyCore = { cur, round2, fmt, toBase, rateAt, toBaseAt, fmtBase, convert, convertAt, accCur, acc, env, catById,
    txParts, activeAccounts, spendableAccounts, investmentAccounts, activeEnvelopes,
    _computeBalances, computeBalances, sumBase, accountBase, envelopeBase, owedBase, totalNet, spendableTotal,
    envelopesTotal, totalOwed, goalsReservedBase, committedEnvelopes, freeMoney, unallocated,
    envSpentInMonth, envFundedInMonth, avgDailySpendBase, distribute, computeIncome, mergeStates, periodReport, sanitizeIds, csvDedupKey, smsAmount, isValidState, syncDecide };
