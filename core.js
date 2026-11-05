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
  return `${n.toLocaleString('ru-RU',{minimumFractionDigits:(n%1?2:0),maximumFractionDigits:2})}\u00a0${c.symbol}`; }   // NBSP: «5 000 ₸» не рвётся на «5 000» / «₸» (1.1.0)
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
// Где используется счёт. Валюту счёта и его физическое удаление разрешаем только пока он нигде не нужен:
//   history   — операции (расход/перевод/зачисление дохода) и долги/возвраты по счёту: двигают баланс, переинтерпретировать нельзя;
//   recurring — регулярный платёж проводится в валюте СЧЁТА, его amount привязан к этой валюте;
//   templates — шаблон хранит счёт и сумму-строку «в валюте счёта».
function accountUsage(id){
  const transactions = (state.transactions||[]).some(t=>t.accountId===id||t.fromAccountId===id||t.toAccountId===id||(t.accountCredits&&t.accountCredits[id]));
  const debts = (state.debts||[]).some(d=>d.accountId===id||(d.payments||[]).some(p=>p.accountId===id));
  return { transactions, debts, history: transactions||debts,
    recurring: (state.recurring||[]).some(r=>r.accountId===id),
    templates: (state.templates||[]).some(t=>t.accountId===id||t.incomeAccountId===id||t.fromAccountId===id||t.toAccountId===id) };
}

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
  const w = e => Math.max(0, +e.percent||0);   // отрицательная доля (вводилась вручную в старых версиях) = 0: иначе в распределении появлялась отрицательная сумма
  const totalW = act.reduce((s,e)=>s+w(e),0);
  if (totalW>0 && act.length) {
    let a=0;
    act.forEach((e,i)=>{ let v = i===act.length-1 ? round2(amount-a) : round2(amount*w(e)/totalW); if(i<act.length-1) a=round2(a+v); dist[e.id]=v; });
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
  const manualWon=new Map();   // код → ручной курс СТАРОЙ стороны, победивший автоматический курс новой
  { const cm=new Map();
    for(const c of (older.currencies||[])) if(c&&c.code) cm.set(c.code,c);
    // Курс, заданный пользователем вручную (manual:true), сильнее автоматически обновлённого: иначе автообновление на «более новом» устройстве затёрло бы ручной курс.
    // Исключение — новая сторона ЯВНО заявила о смене режима (manual:false: владелец снял флажок «вручную»): тогда побеждает она, и снятие флажка не откатывается слиянием.
    // Отсутствие поля (устройство со старой версией или курс никогда не задавался вручную) явной заявкой не считается.
    for(const c of (newer.currencies||[])) if(c&&c.code){ const o=cm.get(c.code);
      if(o && o.manual===true && typeof c.manual!=='boolean'){ cm.set(c.code, o); manualWon.set(c.code, o.rate); }
      else cm.set(c.code, c); }
    if(cm.size) out.currencies=[...cm.values()]; }
  out.rateHistory = Object.assign({}, older.rateHistory||{}, newer.rateHistory||{});
  // Снимок курсов за общую дату берётся целиком у новой стороны — с её АВТОМАТИЧЕСКИМ курсом. Если ручной курс старой стороны победил, снимки тех дат, где он действовал
  // (у старой стороны там записан именно он), поправляем: иначе rateAt() (отчёты, история) и convert() (балансы) оценивали бы одну валюту по разным курсам.
  if(manualWon.size){ const oh=older.rateHistory||{};
    for(const d in oh){ const os=oh[d]; if(!os || typeof os!=='object') continue;
      for(const [code,rate] of manualWon){ if(os[code]===rate){ const cur=out.rateHistory[d]; if(!cur || cur[code]!==rate) out.rateHistory[d]=Object.assign({}, cur||{}, {[code]:rate}); } } } }
  out.rev = Math.max(lRev, rRev);
  out.epoch = Math.max(+local.epoch||0, +remote.epoch||0);   // эпоха осознанной замены данных только растёт: слияние не должно «забывать» замену, сделанную на любой из сторон
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
// ТИПИЗИРОВАННОЕ перенаправление ссылок (аудит 1.0.6, P1): у каждой коллекции свой словарь «старый id → новый id», и поле-ссылка смотрит только в словарь
// СВОЕГО типа (accountId — в словарь счетов, envelopeId — конвертов, categoryId — категорий …). Раньше словарь был один на все коллекции: если счёт, конверт
// и категория имели одинаковый id, переименованный последним перетягивал на себя ссылки всех трёх типов — операция отвязывалась и от счёта, и от конверта.
// Дубль id ВНУТРИ коллекции ссылки не перетягивает: непонятно, на какую из двух записей они указывали, поэтому они остаются у первой (дубликат в любом случае
// отвергает validateState). Новые id уникальны во ВСЕХ коллекциях сразу (надгробия общие на все коллекции — совпадение id привело бы к удалению чужой записи).
function sanitizeIds(state, uidFn){
  const safe = s => String(s==null?'':s).replace(/[^A-Za-z0-9_-]/g,'');
  const colls=['accounts','envelopes','categories','transactions','debts','recurring','goals','events','watchlists','templates'];
  const used=new Set(), maps={}; let renamed=0;
  for(const coll of colls){ maps[coll]=Object.create(null); const seen=new Set();   // без прототипа: id «constructor»/«toString» не должен находиться в словаре как унаследованное свойство
    for(const it of (state[coll]||[])){ if(!it || it.id==null) continue; const id=String(it.id);
      let ns=safe(id) || (uidFn?uidFn():'id'+Math.random().toString(36).slice(2,8));
      if(ns!==id || used.has(ns)){ while(used.has(ns)) ns=ns+'x'+Math.floor(Math.random()*1679616).toString(36);
        if(ns!==id && id!=='' && !seen.has(id)) maps[coll][id]=ns;   // ссылки на старый id идут к ПЕРВОЙ записи с таким id в своей коллекции; '' — это «нет ссылки», её не перенаправляем
        it.id=ns; renamed++; }
      seen.add(id); used.add(String(it.id)); } }   // String: числовой id 7 и строка «7» — один и тот же id (так их сравнивают validateState и надгробия)
  if(!renamed) return state;   // чистые данные — ничего не меняли
  const R=(coll,v)=>(v!=null && maps[coll][String(v)]!=null)?maps[coll][String(v)]:v;
  const fix=(o,k,coll)=>{ if(o && o[k]!=null) o[k]=R(coll,o[k]); };                                                  // поле-ссылка заданного типа
  const keys=(o,coll)=>{ if(!o||typeof o!=='object'||Array.isArray(o)) return o; const n={};   // словарь, ключи которого — id заданного типа
    for(const k in o) Object.defineProperty(n, String(R(coll,k)), { value:o[k], enumerable:true, writable:true, configurable:true });   // defineProperty: ключ «__proto__» — обычный ключ, а не смена прототипа
    return n; };
  for(const t of (state.transactions||[])){ if(!t) continue;
    fix(t,'accountId','accounts'); fix(t,'fromAccountId','accounts'); fix(t,'toAccountId','accounts');
    fix(t,'envelopeId','envelopes'); fix(t,'fromEnvelopeId','envelopes'); fix(t,'toEnvelopeId','envelopes'); fix(t,'categoryId','categories'); fix(t,'recurId','recurring');
    if(Array.isArray(t.splits)) t.splits.forEach(s=>{ fix(s,'envelopeId','envelopes'); fix(s,'categoryId','categories'); });
    if(t.distribution) t.distribution=keys(t.distribution,'envelopes'); if(t.plan) t.plan=keys(t.plan,'envelopes'); if(t.accountCredits) t.accountCredits=keys(t.accountCredits,'accounts'); }
  for(const d of (state.debts||[])){ if(!d) continue; fix(d,'accountId','accounts'); if(Array.isArray(d.payments)) d.payments.forEach(p=>fix(p,'accountId','accounts')); }
  for(const r of (state.recurring||[])){ if(!r) continue; fix(r,'accountId','accounts'); fix(r,'envelopeId','envelopes'); fix(r,'categoryId','categories'); }
  for(const g of (state.goals||[])) fix(g,'envelopeId','envelopes');
  for(const ev of (state.events||[])) fix(ev,'envelopeId','envelopes');
  for(const w of (state.watchlists||[])){ if(w && w.type==='category') fix(w,'value','categories'); }
  for(const tp of (state.templates||[])){ if(!tp) continue;                                                           // раньше шаблоны не перенаправлялись вовсе
    for(const k of ['accountId','incomeAccountId','fromAccountId','toAccountId']) fix(tp,k,'accounts');
    for(const k of ['envelopeId','fromEnvelopeId','toEnvelopeId']) fix(tp,k,'envelopes'); fix(tp,'categoryId','categories');
    if(tp.eqSel) tp.eqSel=keys(tp.eqSel,'envelopes'); if(tp.fund) tp.fund=keys(tp.fund,'envelopes'); }
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
// РЕАЛЬНАЯ календарная дата (не только формат): '2026-02-31' отклоняется.
function isRealDate(s){ s=String(s==null?'':s); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y=+s.slice(0,4), m=+s.slice(5,7), d=+s.slice(8,10); if(m<1||m>12||d<1||d>31) return false;
  const dt=new Date(Date.UTC(y,m-1,d)); return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d; }

// Состояние пригодно к применению? Возвращает null (да) либо { path, reason } — ПЕРВУЮ найденную причину отказа.
// Контракт (аудит 1.0.5, P0.2): всё, что принято, обязано безопасно пройти normalize() и _computeBalances() БЕЗ порчи
// сумм (NaN, «тихий ноль» из fin()), падений и смены смысла записи. Поэтому проверяем ровно то, что потребляют денежные
// расчёты, и в ТЕХ ЖЕ терминах: например, формат перевода определяется так же, как в _computeBalances (fromAmount != null),
// а резервное поле amount не маскирует повреждённые fromAmount/toAmount (иначе normalize превращает "abc" в 0 и на втором
// счёте появляются деньги, которых не списывали с первого).
// Необязательные поля: null/undefined = «не задано» (normalize трактует как x||0); любое иное значение обязано иметь верный тип.
// Ссылочную целостность (id несуществующего счёта и т.п.) НЕ навязываем: старые данные могут содержать «осиротевшие» ссылки,
// расчёты их терпят, а отклонять из-за них файл значило бы закрыть пользователю доступ к его же копии.
function validateState(s){
  const isObj=v=>v!==null && typeof v==='object' && !Array.isArray(v);
  const fin=v=>typeof v==='number' && isFinite(v) && Math.abs(v)<=1e13;   // 1e13 — запас на любые реальные суммы/метки времени; 1e308 дал бы Infinity в итогах
  const has=v=>v!==undefined && v!==null;
  const bad=(path,reason)=>({path,reason});
  const P={   // предикаты: [проверка, причина отказа]
    pos:    [v=>fin(v)&&v>0,                           'нужно число > 0'],
    nn:     [v=>fin(v)&&v>=0,                          'нужно число ≥ 0'],
    fin:    [fin,                                      'нужно конечное число'],
    str1:   [v=>typeof v==='string'&&v!=='',           'нужна непустая строка'],
    str:    [v=>typeof v==='string',                   'нужна строка'],
    bool:   [v=>typeof v==='boolean',                  'нужно true/false'],
    id:     [v=>(typeof v==='string'&&v!=='')||fin(v), 'нужен id'],
    idOpt:  [v=>typeof v==='string'||fin(v),           'нужен id или пустое значение'],
    date:   [isRealDate,                               'нужна реальная дата ГГГГ-ММ-ДД'],
    pct:    [v=>fin(v)&&v>=0&&v<=100,                  'нужно число 0…100'],
    ratePct:[v=>fin(v)&&v>=0&&v<=1000,                 'нужно число 0…1000'],
    day:    [v=>Number.isInteger(v)&&v>=1&&v<=31,      'нужно целое 1…31'],
    ym:     [v=>typeof v==='string'&&/^20\d\d-(0[1-9]|1[0-2])$/.test(v), 'нужен месяц 2000-01…2099-12'],   // «1900-01»/«9999-12» заставили бы автопроведение создать тысячи операций
    code:   [v=>typeof v==='string'&&/^[A-Za-z0-9]{1,5}$/.test(v), 'код валюты: 1–5 латинских букв или цифр'],   // иное normalize() молча выбросит вместе с валютой
    amtStr: [v=>typeof v==='string'&&(v===''||isFinite(parseFloat(v))), 'нужна строка с числом'],
    kind:   [v=>v==='expense'||v==='income',           'нужно expense или income'],
    mode:   [v=>v==='expense'||v==='income'||v==='transfer', 'неизвестный режим'],
  };
  const R=true;   // поле обязательно
  const fields=(o,path,spec)=>{ for(const k in spec){ const [p,req]=spec[k], v=o[k];
      if(!has(v)){ if(req) return bad(`${path}.${k}`,'обязательное поле отсутствует'); continue; }
      if(!p[0](v)) return bad(`${path}.${k}`,p[1]); } return null; };
  const each=(arr,path,fn)=>{ for(let i=0;i<arr.length;i++){ const it=arr[i], p=`${path}[${i}]`;
      if(!isObj(it)) return bad(p,'нужен объект'); const e=fn(it,p); if(e) return e; } return null; };
  const moneyMap=(m,path)=>{ if(!isObj(m)) return bad(path,'нужен объект');
    for(const k in m) if(!P.nn[0](m[k])) return bad(`${path}.${k}`,P.nn[1]); return null; };
  const credits=(m,path)=>{ if(!isObj(m)) return bad(path,'нужен объект');
    for(const k in m){ const v=m[k];
      if(isObj(v)){ const e=fields(v,`${path}.${k}`,{amt:[P.nn,R],cur:[P.str1,R]}); if(e) return e; }   // формат {amt,cur}
      else if(!P.nn[0](v)) return bad(`${path}.${k}`,'нужно число ≥ 0 или {amt,cur}'); }                // старый формат: просто число
    return null; };
  // Коллекция с id: каждый элемент — объект с непустым уникальным id + проверка полей самого элемента.
  // id уникален и ВО ВСЕХ коллекциях сразу (аудит 1.0.6, P1): надгробия общие на все коллекции (mergeStates удаляет по id в каждой), а перенаправление ссылок
  // при нормализации идёт по id — совпадение, например, счёта и конверта привело бы к удалению/перепривязке чужой записи.
  const owner=new Map();   // id → коллекция, в которой он уже встретился
  const claim=(key,id,p)=>{ const other=owner.get(id); if(other && other!==key) return bad(`${p}.id`,`id уже занят записью из «${other}»`); owner.set(id,key); return null; };
  const coll=(key,fn)=>{ const arr=s[key]; if(!has(arr)) return null; const seen=new Set();
    return each(arr,key,(it,p)=>{ if(it.id==null||String(it.id)==='') return bad(`${p}.id`,'нет id');
      const id=String(it.id); if(seen.has(id)) return bad(`${p}.id`,'повтор id'); seen.add(id);
      const c=claim(key,id,p); if(c) return c; return fn?fn(it,p):null; }); };

  if(!isObj(s)) return bad('state','нужен объект');
  if(typeof s.baseCurrency!=='string'||!s.baseCurrency) return bad('baseCurrency','нужна непустая строка');
  if(!Array.isArray(s.currencies)||!s.currencies.length) return bad('currencies','нужен непустой массив');
  for(const k of ['transactions','accounts','envelopes','categories']) if(!Array.isArray(s[k])) return bad(k,'нужен массив');
  for(const k of ['debts','recurring','goals','events','templates','watchlists']) if(has(s[k])&&!Array.isArray(s[k])) return bad(k,'нужен массив');

  // Валюты: непустой code, конечный rate>0; без дублей (сравнение как в normalize — UPPERCASE); база с курсом 1.
  const codes=new Set();
  let e=each(s.currencies,'currencies',(c,p)=>{ const r=fields(c,p,{code:[P.code,R],rate:[P.pos,R],manual:[P.bool]}); if(r) return r;
    const up=c.code.toUpperCase(); if(codes.has(up)) return bad(`${p}.code`,'повтор кода валюты'); codes.add(up); return null; });
  if(e) return e;
  const baseUp=s.baseCurrency.toUpperCase();
  if(!codes.has(baseUp)) return bad('baseCurrency','базовой валюты нет среди валют');
  if(Math.abs(s.currencies.find(c=>c.code.toUpperCase()===baseUp).rate-1)>1e-9) return bad('currencies','курс базовой валюты должен быть 1');   // иначе toBase исказит ВСЕ суммы

  // Справочники. Числовые поля — ровно в тех границах, которые normalize() принудительно подрезает (чтобы подрезка была no-op).
  e=coll('accounts',(a,p)=>fields(a,p,{currency:[P.str],offTopPercent:[P.pct],rate:[P.ratePct],investment:[P.bool],excluded:[P.bool],archived:[P.bool],deposit:[P.bool]})); if(e) return e;
  e=coll('envelopes',(v,p)=>fields(v,p,{percent:[P.nn],monthlyTarget:[P.nn],monthlyLimit:[P.nn],archived:[P.bool],noOwe:[P.bool]})); if(e) return e;   // percent ≥ 0: отрицательная доля дала бы отрицательное распределение дохода
  e=coll('categories',(c,p)=>fields(c,p,{kind:[P.kind],limit:[P.fin],fav:[P.bool]})); if(e) return e;

  // Операции — то, что реально двигает деньги. Обязательные поля те же, что читает _computeBalances для каждого типа.
  const TYPES=new Set(['income','expense','transfer','envtransfer','envfund','adjust','envadjust']);
  e=coll('transactions',(t,p)=>{
    if(!TYPES.has(t.type)) return bad(`${p}.type`,'неизвестный тип операции');
    const d=fields(t,p,{date:[P.date,R]}); if(d) return d;
    switch(t.type){
      case 'income':
        return fields(t,p,{amount:[P.pos,R],currency:[P.str1,R]})
          || (has(t.accountCredits)?credits(t.accountCredits,`${p}.accountCredits`):null)
          || (has(t.distribution)?moneyMap(t.distribution,`${p}.distribution`):null)
          || (has(t.plan)?moneyMap(t.plan,`${p}.plan`):null);
      case 'expense': {
        const r=fields(t,p,{amount:[P.pos,R],currency:[P.str1,R],accountId:[P.idOpt],envelopeId:[P.idOpt],categoryId:[P.idOpt]}); if(r) return r;
        if(!has(t.splits)) return null;
        if(!Array.isArray(t.splits)) return bad(`${p}.splits`,'нужен массив');
        const se=each(t.splits,`${p}.splits`,(sp,sp_)=>fields(sp,sp_,{amount:[P.pos,R],categoryId:[P.idOpt],envelopeId:[P.idOpt]})); if(se) return se;
        // normalize() удаляет «разделение» из <2 частей, и расход берёт конверт/категорию верхнего уровня: единственная часть обязана с ними совпадать,
        // иначе сумма молча перетекла бы в другой конверт (приложение такого не пишет — нужно ≥2 части).
        if(t.splits.length===1){ const sp=t.splits[0]; const same=(a,b)=>(a==null||a==='')?(b==null||b===''):a===b;
          if(!same(sp.envelopeId,t.envelopeId) || !same(sp.categoryId,t.categoryId)) return bad(`${p}.splits`,'одна часть должна совпадать с конвертом/категорией операции'); }
        return null; }
      case 'transfer': {
        const r=fields(t,p,{fromAccountId:[P.id,R],toAccountId:[P.id,R],amount:[P.fin]}); if(r) return r;   // amount, если задан, обязан быть числом
        // Формат определяем как _computeBalances: есть fromAmount/toAmount → считают ТОЛЬКО они (amount игнорируется).
        if(has(t.fromAmount)||has(t.toAmount)) return fields(t,p,{fromAmount:[P.pos,R],toAmount:[P.pos,R],fromCurrency:[P.str1,R],toCurrency:[P.str1,R]});
        return fields(t,p,{amount:[P.pos,R],currency:[P.str1,R]}); }                                         // старый формат: amount + currency
      case 'envtransfer':
        return fields(t,p,{amount:[P.pos,R],currency:[P.str1,R],fromEnvelopeId:[P.id,R],toEnvelopeId:[P.id,R]});
      case 'envfund': case 'envadjust':   // знаковые: возврат/корректировка могут быть отрицательными
        return fields(t,p,{amount:[P.fin,R],currency:[P.str1,R],envelopeId:[P.id,R]});
      case 'adjust':
        return fields(t,p,{amount:[P.fin,R],currency:[P.str1,R],accountId:[P.id,R]});
    }
    return null; });
  if(e) return e;

  // Долги: тело и возвраты двигают баланс счёта.
  e=coll('debts',(d,p)=>{ const r=fields(d,p,{amount:[P.pos,R],currency:[P.str],accountId:[P.idOpt],rate:[P.nn],direction:[P.str]}); if(r) return r;
    if(!has(d.payments)) return null;
    if(!Array.isArray(d.payments)) return bad(`${p}.payments`,'нужен массив');
    return each(d.payments,`${p}.payments`,(pay,pp)=>fields(pay,pp,{amount:[P.pos,R],date:[P.date],accountId:[P.idOpt]})); });
  if(e) return e;

  // Цели: saved резервируется из «Свободно» (goalsReservedBase), target/log показываются и считаются прогрессом.
  e=coll('goals',(g,p)=>{ const r=fields(g,p,{target:[P.nn],saved:[P.fin],currency:[P.str],envelopeId:[P.idOpt],archived:[P.bool]}); if(r) return r;
    if(!has(g.log)) return null;
    if(!Array.isArray(g.log)) return bad(`${p}.log`,'нужен массив');
    return each(g.log,`${p}.log`,(l,lp)=>fields(l,lp,{amount:[P.fin,R],date:[P.date]})); });
  if(e) return e;

  // События календаря: реальная дата (иначе normalize молча отфильтрует/исказит) и числовая сумма.
  e=coll('events',(ev,p)=>fields(ev,p,{date:[P.date,R],amount:[P.fin],currency:[P.str],envelopeId:[P.idOpt],done:[P.bool]})); if(e) return e;

  // Регулярные платежи проводятся АВТОМАТИЧЕСКИ при запуске/синхронизации → amount обязан быть числом, иначе родится NaN-операция.
  e=coll('recurring',(r,p)=>fields(r,p,{amount:[P.pos,R],type:[P.kind],day:[P.day],accountId:[P.idOpt],envelopeId:[P.idOpt],categoryId:[P.idOpt],currency:[P.str],lastPosted:[P.ym],active:[P.bool],auto:[P.bool]})); if(e) return e;

  // Шаблоны быстрого ввода: сумма хранится СТРОКОЙ (amtStr — набор с клавиатуры), режим — один из трёх.
  e=coll('templates',(t,p)=>fields(t,p,{mode:[P.mode],amtStr:[P.amtStr],currency:[P.str]})); if(e) return e;

  // Лимиты/наблюдения (id не навязываем — как и раньше).
  if(has(s.watchlists)){ const seenW=new Set();
    e=each(s.watchlists,'watchlists',(w,p)=>{ if(w.id!=null && String(w.id)!==''){ const id=String(w.id); if(seenW.has(id)) return bad(`${p}.id`,'повтор id'); seenW.add(id); const c=claim('watchlists',id,p); if(c) return c; }
      return fields(w,p,{target:[P.fin],type:[P.str],value:[P.str]}); }); if(e) return e; }

  // Исторические курсы: ключи — реальные даты, значения — числа. Непоимённые (≤0) значения НЕ отвергаем: rateAt() их игнорирует и берёт текущий курс,
  // а отвергать нельзя — вручную эту историю не поправить, и одна «отравленная» запись навсегда заблокировала бы синхронизацию/импорт/восстановление.
  if(has(s.rateHistory)){ if(!isObj(s.rateHistory)) return bad('rateHistory','нужен объект');
    for(const d in s.rateHistory){ if(!isRealDate(d)) return bad(`rateHistory.${d}`,'ключ должен быть датой ГГГГ-ММ-ДД');
      const snap=s.rateHistory[d]; if(!isObj(snap)) return bad(`rateHistory.${d}`,'нужен объект {код: курс}');
      for(const c in snap) if(!P.fin[0](snap[c])) return bad(`rateHistory.${d}.${c}`,P.fin[1]); } }
  // Надгробия: {id: метка времени}; mergeStates сравнивает их числами.
  if(has(s.tombstones)){ if(!isObj(s.tombstones)) return bad('tombstones','нужен объект');
    for(const k in s.tombstones) if(!P.fin[0](s.tombstones[k])) return bad(`tombstones.${k}`,P.fin[1]); }

  // Скалярные настройки верхнего уровня.
  return fields(s,'state',{debtBudget:[P.fin],overAllocBaseline:[P.fin],debtStrategy:[P.str],rev:[P.fin],epoch:[P.nn],version:[P.fin],categoriesVersion:[P.fin],ratesUpdated:[P.str]});
}
function isValidState(s){ return validateState(s)===null; }

// Есть ли в состоянии пользовательские данные/настройки, которые будут потеряны при замене (P0.2 / аудит 1.0.5 P0.1).
// «Чистое» стартовое состояние (дефолтные счета/конверты/категории/валюты, без операций) → false.
// defaults — эталон (defaultState()): всё, что ОТЛИЧАЕТСЯ от него по любому полю, считается пользовательской настройкой.
// Сравнение ГЕНЕРИЧЕСКОЕ (по всем полям сущности, кроме id), а не по списку «известных» полей: так новое поле будущей версии
// не выпадет из защиты молча (fail-safe — худший исход ложное срабатывание, а не потеря настройки). Чтобы сырой дефолт и
// уже нормализованный (normalize() дописывает false/0/'' и иконку конверта) выглядели одинаково, «пустые» значения
// отбрасываются и подставляются те же умолчания иконки/цвета, что ставит normalize().
// НЕ считаются пользовательскими данными (технические/производные): id (случайные), rev, epoch, ratesUpdated, version, АВТОМАТИЧЕСКИ обновляемые курсы валют
// и rateHistory (снимок курсов пишется при КАЖДОМ запуске — без этого любое устройство выглядело бы «занятым»). Курс, заданный вручную (currencies[].manual:true), и ЯВНОЕ возвращение
// на автообновление (manual:false) — решения пользователя: они считаются данными. Отсутствие поля manual — «не трогали», данными не считается.
// Если defaults не передан, проверяются только коллекции пользовательских записей и надгробия.
// Разделы accounts/envelopes/categories/currencies сравниваются, только если они есть в эталоне; прочие скаляры верхнего уровня —
// всегда (поле, которого нет в эталоне, считается «пусто по умолчанию»: непустое значение = пользовательская настройка).
function hasUserData(s, defaults){ if(!s || typeof s!=='object') return false;
  if(['transactions','debts','goals','events','templates','recurring','watchlists'].some(k=>Array.isArray(s[k]) && s[k].length)) return true;
  if(s.tombstones && typeof s.tombstones==='object' && Object.keys(s.tombstones).length) return true;   // что-то удаляли → был пользовательский ввод
  if(!defaults || typeof defaults!=='object') return false;
  const empty=v=>v===undefined||v===null||v===false||v===0||v===''||(Array.isArray(v)&&!v.length)||(typeof v==='object'&&!Array.isArray(v)&&!Object.keys(v).length);
  const num=v=>typeof v==='number'?Math.round(v*1e6)/1e6:v;
  const canon=(o,fb)=>{ const r=Object.assign({},fb);                            // умолчания normalize()
    for(const k in (o||{})){ if(k==='id') continue; const v=o[k]; if(!empty(v)) r[k]=num(v); }
    return JSON.stringify(Object.keys(r).sort().map(k=>[k,r[k]])); };
  const FB={ accounts:{color:'#5b8def',icon:'💳'}, envelopes:{color:'#5b8def',icon:'✉️'}, categories:{color:'#94a3b8',icon:'🏷️'} };
  const sig=(arr,fb)=>(Array.isArray(arr)?arr:[]).map(o=>canon(o,fb)).sort();
  const same=(a,b)=>a.length===b.length && a.every((x,i)=>x===b[i]);
  for(const k of ['accounts','envelopes','categories']){ if(!Array.isArray(defaults[k])) continue;
    if(!same(sig(s[k],FB[k]), sig(defaults[k],FB[k]))) return true; }
  if(Array.isArray(defaults.currencies)){   // набор валют (код+символ). Автоматически обновляемые курсы НЕ сравниваем, а курс, заданный ВРУЧНУЮ (manual), — данные пользователя
    // manual:true → 'm'+курс (владелец задал курс сам); manual:false → 'a' (владелец ЯВНО вернул валюту на автообновление — это его решение, оно должно пережить замену данных);
    // поля нет → '' (курс никогда не трогали: автообновление курса данными пользователя не считается).
    const cs=a=>(Array.isArray(a)?a:[]).map(c=>`${String(c&&c.code||'').toUpperCase()}|${(c&&c.symbol)||''}|${c&&c.manual===true?'m'+num(+c.rate||0):(c&&c.manual===false?'a':'')}`).sort();
    if(!same(cs(s.currencies), cs(defaults.currencies))) return true; }
  // Прочие скаляры верхнего уровня: baseCurrency, debtBudget, debtStrategy, overAllocBaseline и любые будущие.
  const SKIP=new Set(['version','categoriesVersion','rev','epoch','ratesUpdated','rateHistory','tombstones','currencies','accounts','envelopes','categories',
    'transactions','debts','goals','events','templates','recurring','watchlists']);
  for(const k of Object.keys(s)){ if(SKIP.has(k) || empty(s[k])) continue;   // нет значения = по умолчанию
    if(JSON.stringify(num(s[k]))!==JSON.stringify(empty(defaults[k])?'':num(defaults[k]))) return true; }
  return false; }

// Защита от «потерянного обновления» (найдено при проверке аудита 1.0.5). Gist не умеет «записать, только если не менялось»:
// если два устройства синхронизируются одновременно (оба вытянули облако ДО выгрузки другого), второй PATCH затирает первый,
// и устройство, чья выгрузка потеряна, при следующей синхронизации видит «менялось только облако» и слепо ЗАМЕНЯЕТ своё —
// тихо теряя свои операции. adopt допустим, только если облако ЗНАЕТ обо всём, что есть у нас: запись присутствует в облаке
// либо её удаление зафиксировано надгробием. Иначе вместо замены делаем слияние (mergeStates сохраняет обе стороны).
function adoptWouldLose(local, remote){
  if(!local || !remote) return false;
  const COLLS=['transactions','accounts','envelopes','categories','debts','recurring','goals','events','watchlists','templates'];
  const rt=(remote.tombstones&&typeof remote.tombstones==='object')?remote.tombstones:{};
  for(const c of COLLS){ const have=new Set((Array.isArray(remote[c])?remote[c]:[]).map(x=>x&&x.id!=null?String(x.id):null));
    for(const it of (Array.isArray(local[c])?local[c]:[])){ if(it && it.id!=null && !have.has(String(it.id)) && !(String(it.id) in rt)) return true; } }
  // Наше удаление, о котором облако не знает → адопт воскресил бы запись. Надгробия старше срока хранения (400 дн.) normalize() всё равно вычистит.
  const lt=(local.tombstones&&typeof local.tombstones==='object')?local.tombstones:{}, cutoff=Date.now()-400*864e5;
  for(const id in lt){ if(!(id in rt) && !((+lt[id]||0) && (+lt[id])<cutoff)) return true; }
  return false; }

// Общая «родословная»: у двух состояний есть хотя бы одна запись с одним и тем же id (одно произошло из другого либо оба — из общего облака).
// Независимые состояния (у каждого свои случайные «дефолтные» счета/конверты/категории) слиянием соединять нельзя: дефолты задвоятся (проценты конвертов 200%).
function sharesLineage(a, b){
  if(!a || !b) return false;
  const COLLS=['transactions','accounts','envelopes','categories','debts','recurring','goals','events','watchlists','templates'];
  for(const c of COLLS){ const have=new Set(); for(const x of (Array.isArray(b[c])?b[c]:[])) if(x && x.id!=null) have.add(String(x.id));
    for(const it of (Array.isArray(a[c])?a[c]:[])) if(it && it.id!=null && have.has(String(it.id))) return true; }
  return false; }

// Оркестрация синхронизации БЕЗ ввода-вывода: решение + последовательность стадий, адаптеры инъектируются.
// Один и тот же код гоняет приложение (index.html через syncAdapters) и интеграционные тесты (sync.test.js с фейками).
// ad: { pull:async()=>{kind:'missing'|'corrupt'|'ok',state?}, push:async(state)=>rev, backup:async()=>bool, persist:(state)=>bool, now:()=>number,
//       current?:()=>живое состояние, stamp?:()=>версия данных (растёт при любой правке и замене) }
// Возвращает {action, ok, error?, base, cloudUpdated, savedLocal, state?}.
//
// Устаревший контекст (аудит: «одновременная работа синхронизации и восстановления»). ctx.state снят ДО ожиданий (сеть, копия в
// IndexedDB). Пока ждём, состояние могут ЗАМЕНИТЬ (восстановление, импорт, сброс) либо правит сам пользователь. Решение и тем более
// запись по устаревшему контексту тихо стёрли бы это (на экране при этом «Восстановлено ✓»). Поэтому после КАЖДОГО ожидания, перед
// записью, сверяем: current() всё ещё ctx.state (не подменено) и stamp() не изменился (не правили). Иначе — отмена без записи и
// {error:'changed', retry:true}: вызывающий повторит синхронизацию уже на актуальных данных. Адаптеры current/stamp необязательны.
async function runSync(ad, ctx){
  const replaced = () => !!(ad.current && ad.current()!==ctx.state);
  const stale = extra => Object.assign({ action:'stale', ok:false, error:'changed', retry:true }, extra||{});
  let p; try{ p = await ad.pull(); }catch(e){ return { action:'error', ok:false, error:'network' }; }
  if(!p || p.kind==='corrupt') return { action:'corrupt', ok:false, error:'corrupt', detail:(p&&p.detail)||null };
  if(replaced()) return stale();                                   // состояние подменили, пока шёл запрос → решать по нему нельзя
  const stamp0 = ad.stamp ? ad.stamp() : null;                     // версия данных на момент решения (снимаем синхронно с чтением rev)
  const edited = () => replaced() || (ad.stamp ? ad.stamp()!==stamp0 : false);
  const remote = p.kind==='ok' ? p.state : null;
  const localRev = +ctx.state.rev||0, remoteRev = remote?(+remote.rev||0):-1, base = +ctx.base||0;
  let act = syncDecide(localRev, remoteRev, base, !!remote);
  // Устройство, которое ещё ни разу не синхронизировалось (base=0) и не содержит ничего своего, обязано ПРИНЯТЬ облако целиком:
  // слияние добавило бы в облако его случайные «дефолтные» счета/конверты (задвоение). Так штатно повторяется и неудавшееся первичное подключение.
  const pristineNew = base===0 && !!ctx.defaults && !hasUserData(ctx.state, ctx.defaults);
  // Присоединение (base=0, облако уже есть) устройства со СВОИМИ данными, у которого с облаком нет ни одного общего id (аудит 1.0.7, ревью): слияние двух независимых
  // «родословных» задвоило бы дефолтные счета/конверты/категории (проценты конвертов 200%) и отправило это в облако на все устройства — это была бы та же ошибка, от
  // которой защищает pristineNew, только для устройства с данными (например, повтор после «подключение не завершено»). Поэтому, как и при первичном подключении,
  // облако принимается целиком, с обязательной копией — но только по явному действию владельца (ctx.interactive!==false): фоновая синхронизация данные не заменяет.
  // Общие id есть (создали облако из этого состояния; устройство, подключённое до появления базы синхронизации) → прежнее поведение: слияние без потерь.
  const joinLike = base===0 && !!remote && !pristineNew && !sharesLineage(ctx.state, remote);
  // Осознанная замена данных на ДРУГОМ устройстве (восстановление копии / импорт / сброс) помечена эпохой: если эпоха облака новее той, что знаем мы,
  // облако — не «потерянное обновление», а решение владельца; принимаем его целиком (как и делала 1.0.5), иначе наши старые записи и надгробия
  // вернулись бы слиянием и отменили замену (при сбросе — ещё и задвоили дефолтные счета/конверты: проценты конвертов 200%). Копия перед заменой обязательна.
  const authoritative = !!remote && (+remote.epoch||0) > (+ctx.state.epoch||0);
  if(remote && (pristineNew || joinLike) && act!=='noop') act='adopt';
  else if(act==='adopt' && !authoritative && adoptWouldLose(ctx.state, remote)) act='merge';   // замена потеряла бы наши записи/удаления (гонка двух устройств) → сливаем
  if(act==='noop') return { action:'noop', ok:true, base, cloudUpdated:false, savedLocal:true };
  if(act==='push'){
    // Аудит 1.0.5: тот же валидатор, что стоит на входе (pull), стоит и на выходе — иначе устройство выгрузит состояние,
    // которое другие устройства сочтут «повреждённым облаком», и синхронизация встанет у всех. Локальное при этом не трогаем.
    const lv = validateState(ctx.state);
    if(lv) return { action:'push', ok:false, error:'local-invalid', detail:lv, cloudUpdated:false };
    let rev; try{ rev = await ad.push(ctx.state); }catch(e){ return { action:'push', ok:false, error:'network', cloudUpdated:false }; }
    // Подменили состояние, пока шла выгрузка: persist(ctx.state) вернул бы ЗАМЕНЁННОЕ устаревшим. Облако уже получило прежнее состояние —
    // новое локальное не трогаем и базу не двигаем: следующая синхронизация (локальное ≠ база, облако ≠ база) сольёт обе стороны без потерь.
    // (Обычная правка пользователя во время выгрузки допустима: persist применяет то же живое состояние, база остаётся позади → дозагрузим.)
    if(replaced()) return stale({ cloudUpdated:true });
    const saved = ad.persist(ctx.state);
    return { action:'push', ok:saved, cloudUpdated:true, savedLocal:saved, base: saved?rev:base, error: saved?null:'persist' };
  }
  if(act==='adopt'){
    const rv = validateState(remote);
    if(rv) return { action:'adopt', ok:false, error:'invalid', detail:rv };
    if(joinLike && ctx.interactive===false) return { action:'adopt', ok:false, error:'join-pending' };   // фоновый запуск: данные владельца не заменяем, ждём явного «Синхронизировать сейчас»
    const bk = await ad.backup();
    if(edited()) return stale();                                   // пока делалась копия, данные поменялись → замена стёрла бы правку/восстановление
    if(!bk && hasUserData(ctx.state, ctx.defaults)) return { action:'adopt', ok:false, error:'backup' };   // P0.1/P0.2: не заменяем кастомизированное локальное без копии
    const replacedElsewhere = authoritative && adoptWouldLose(ctx.state, remote);   // замена реально уберёт наши записи → пользователю нужно честное сообщение
    const saved = ad.persist(remote);
    return { action:'adopt', ok:saved, cloudUpdated:false, savedLocal:saved, base: saved?remoteRev:base, error: saved?null:'persist', state:remote, replacedElsewhere, joined: joinLike };
  }
  // merge
  const merged = mergeStates(ctx.state, remote); merged.rev = ad.now();
  const mv = validateState(merged);   // результат слияния — тоже «принимаемое» состояние: проверяем ДО копии и записи
  if(mv) return { action:'merge', ok:false, error:'merge-invalid', detail:mv };
  const bk = await ad.backup();
  if(edited()) return stale();                                     // слитое посчитано по устаревшему состоянию → записывать его нельзя
  if(!bk) return { action:'merge', ok:false, error:'backup' };   // P0-d: не сливаем без обязательной копии
  const saved = ad.persist(merged);
  if(!saved) return { action:'merge', ok:false, error:'persist', savedLocal:false, cloudUpdated:false, state:merged };
  let rev; try{ rev = await ad.push(merged); }catch(e){ return { action:'merge', ok:false, error:'network', savedLocal:true, cloudUpdated:false, base: merged.rev, state:merged }; }
  return { action:'merge', ok:true, cloudUpdated:true, savedLocal:true, base: rev, state:merged };
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
  let m; const hits=[]; let prevEnd=0;
  while((m=re.exec(s))){ const n=parseFloat(m[1].replace(/\s/g,'').replace(',','.'));
    const before=s.slice(prevEnd, m.index); prevEnd=re.lastIndex;   // P1.4: контекст = сегмент от прошлого числа до этого → слово привязано к ближайшему числу, не «протекает» на соседнее
    if(isNaN(n)) continue;
    hits.push({n, bal:BAL.test(before), op:OP.test(before)}); }
  if(hits.length){ const nonBal=hits.filter(h=>!h.bal);
    if(!nonBal.length) return null;   // P1.4: все найденные суммы с валютой — это остаток/баланс → не угадываем, пусть пользователь введёт
    const near=nonBal.filter(h=>h.op);   // предпочитаем число рядом со словом операции
    return round2((near.length?near[0]:nonBal[0]).n); }
  // запасной вариант — самое большое число, не являющееся маской карты (*1234)
  const nums=[]; let mm; const re2=/(^|[^\d*])(\d[\d\s]{0,12}(?:[.,]\d{1,2})?)/g;
  while((mm=re2.exec(s))){ const n=parseFloat(mm[2].replace(/\s/g,'').replace(',','.')); if(!isNaN(n)) nums.push(n); }
  return nums.length? round2(Math.max(...nums)) : null;
}

// Единое пространство функций ядра. Выставляем ВСЕГДА (и в Deno/Node, и в браузере) — так и tests.html,
// и core.test.js берут ОДИН и тот же набор (пункт P1.7: раньше tests.html собирал C вручную и отставал).
// В приложении это просто дополнительный глобальный объект-ссылка, на логику не влияет.
globalThis.KonvertyCore = { cur, round2, fmt, toBase, rateAt, toBaseAt, fmtBase, convert, convertAt, accCur, acc, env, catById,
    txParts, activeAccounts, spendableAccounts, investmentAccounts, activeEnvelopes, accountUsage,
    _computeBalances, computeBalances, sumBase, accountBase, envelopeBase, owedBase, totalNet, spendableTotal,
    envelopesTotal, totalOwed, goalsReservedBase, committedEnvelopes, freeMoney, unallocated,
    envSpentInMonth, envFundedInMonth, avgDailySpendBase, distribute, computeIncome, mergeStates, periodReport, sanitizeIds, csvDedupKey, smsAmount, isValidState, validateState, isRealDate, syncDecide, hasUserData, adoptWouldLose, sharesLineage, runSync };
