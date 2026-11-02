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
    addAcc(d.accountId, accCur(d.accountId), sign * convert(d.amount, d.currency, accCur(d.accountId)));
    for (const p of (d.payments||[])) {
      const pa = (p.accountId && acc(p.accountId)) ? p.accountId : d.accountId;
      addAcc(pa, accCur(pa), -sign * convert(p.amount, d.currency, accCur(pa)));   // возврат — в обратную сторону
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
  if (offSumMain>amount && offSumMain>0){ const k=amount/offSumMain;
    for (const o of Object.values(offTop)){ o.amtMain=round2(o.amtMain*k); o.amt=convert(o.amtMain, mainCur, o.cur); }
    offSumMain=amount;
  }
  const remainder = round2(Math.max(0, amount - offSumMain));    // в валюте дохода
  const accountCredits = {};
  for (const [id,o] of Object.entries(offTop)) accountCredits[id] = { amt:o.amt, cur:o.cur };
  accountCredits[mainAccountId] = { amt:remainder, cur:mainCur };
  return { accountCredits, distribution: distribute(remainder), distCurrency:mainCur, remainder, offTop, mainCur };
}

// Экспорт для не-браузерных сред (Deno/Node) — чтобы тесты могли дотянуться до функций.
// В браузере есть globalThis.document → блок пропускается, на приложение не влияет.
if (typeof globalThis.document === 'undefined') {
  globalThis.KonvertyCore = { cur, round2, fmt, toBase, rateAt, toBaseAt, fmtBase, convert, accCur, acc, env, catById,
    txParts, activeAccounts, spendableAccounts, investmentAccounts, activeEnvelopes,
    _computeBalances, computeBalances, sumBase, accountBase, envelopeBase, owedBase, totalNet, spendableTotal,
    envelopesTotal, totalOwed, goalsReservedBase, committedEnvelopes, freeMoney, unallocated,
    envSpentInMonth, envFundedInMonth, avgDailySpendBase, distribute, computeIncome };
}
