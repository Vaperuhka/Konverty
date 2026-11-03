/* =====================================================================
   sync.test.js — ИНТЕГРАЦИОННЫЙ стенд синхронизации (Deno).
   Отвечает на главное замечание аудита: нужны проверки СОХРАНЕНИЯ/СИНКА,
   а не только юнит-тесты арифметики. Моделируем два устройства поверх
   фейкового gist-а в памяти и гоняем РЕАЛЬНУЮ логику ядра:
   syncDecide() (решение), mergeStates() (слияние), isValidState() (защита).
   Шаг apply в точности повторяет ветки syncNow() в index.html.
   Запуск:  deno run sync.test.js
   ===================================================================== */
import './core.js';
const C = globalThis.KonvertyCore;

let clock = 1000;              // монотонные ревизии (детерминированная замена Date.now)
const nextRev = () => ++clock;
const clone = o => JSON.parse(JSON.stringify(o));

function mkState(extra){ return Object.assign({
  rev: 0, baseCurrency: 'KZT',
  currencies: [{code:'KZT',symbol:'₸',rate:1}],
  tombstones: {}, transactions: [], accounts: [{id:'acc1'}], envelopes: [], categories: [],
  debts: [], recurring: [], goals: [], events: [], watchlists: [], templates: []
}, extra||{}); }

// Устройство: своё состояние + своя база (ревизия последней синхронизации).
function device(name, state){ return { name, state: state||mkState(), base: 0 }; }

// Локальное изменение: мутируем и поднимаем rev (как save()).
function edit(dev, fn){ fn(dev.state); dev.state.rev = nextRev(); }

// Фейковый gist: { content: string|null }. null = файла нет (новое/пустое облако).
function pull(gist){
  if(gist.content===null) return {remote:null};                 // нет файла
  let data=null; try{ data=JSON.parse(gist.content); }catch(e){ data=null; }
  if(!C.isValidState(data)) return {corrupt:true};              // файл есть, но битый
  return {remote:data};
}

// Шаг синхронизации устройства — зеркало веток syncNow().
function sync(dev, gist){
  const p = pull(gist);
  if(p.corrupt) return 'corrupt';                                // абортим, локальное не трогаем, gist не перезаписываем
  const remote = p.remote;
  const localRev = +dev.state.rev||0, remoteRev = remote?(+remote.rev||0):-1, base = dev.base;
  const act = C.syncDecide(localRev, remoteRev, base, !!remote);
  if(act==='push'){ gist.content = JSON.stringify(dev.state); dev.base = localRev; }
  else if(act==='adopt'){ dev.state = clone(remote); dev.base = +remote.rev||0; }
  else if(act==='noop'){ /* ничего */ }
  else { const merged = C.mergeStates(clone(dev.state), remote); merged.rev = nextRev();
         dev.state = merged; gist.content = JSON.stringify(merged); dev.base = merged.rev; }
  return act;
}

/* ---------------- проверки ---------------- */
const res=[]; const ok=(name,cond,info)=>res.push({name,ok:!!cond,info:cond?'':(info||'')});
const txIds = s => s.transactions.map(t=>t.id).sort().join(',');

// 1) Новое устройство подхватывает облако целиком (adopt).
(()=>{ const g={content:null};
  const A=device('A', mkState({transactions:[{id:'t1',type:'expense',amount:100,currency:'KZT'}]})); edit(A,()=>{});
  sync(A,g);                                   // push → gist = A
  const B=device('B');                         // новое устройство, rev 0, base 0
  const act=sync(B,g);
  ok('новое устройство: adopt', act==='adopt');
  ok('B получил операцию A', txIds(B.state)==='t1'); })();

// 2) Правки офлайн на двух устройствах сливаются без потерь (edit/edit → merge).
(()=>{ const g={content:null};
  const base=mkState({transactions:[{id:'t1',type:'expense',amount:100,currency:'KZT'}]}); edit({state:base},()=>{});
  const A=device('A', clone(base)); const B=device('B', clone(base));
  // оба синхронизированы к общей базе
  sync(A,g); B.base=A.base; B.state.rev=A.state.rev; B.state=clone(JSON.parse(g.content));
  // уходят офлайн, каждый добавляет свою операцию
  edit(A, s=>s.transactions.push({id:'ta',type:'expense',amount:10,currency:'KZT'}));
  edit(B, s=>s.transactions.push({id:'tb',type:'expense',amount:20,currency:'KZT'}));
  const a1=sync(A,g);                           // только A менялся относительно базы → push
  const b1=sync(B,g);                           // обе стороны менялись → merge
  ok('A→push, B→merge', a1==='push' && b1==='merge');
  ok('после merge у B все три операции', txIds(B.state)==='t1,ta,tb', txIds(B.state));
  const a2=sync(A,g);                            // A подхватывает слитое
  ok('A подхватил слитое (adopt)', a2==='adopt');
  ok('у A тоже все три операции', txIds(A.state)==='t1,ta,tb', txIds(A.state)); })();

// 3) Удаление на одном ↔ правка на другом: надгробие побеждает, запись не воскресает.
(()=>{ const g={content:null};
  const base=mkState({transactions:[{id:'t1',type:'expense',amount:100,currency:'KZT'},{id:'t2',type:'expense',amount:50,currency:'KZT'}]});
  const A=device('A', clone(base)); edit(A,()=>{}); sync(A,g);
  const B=device('B', clone(JSON.parse(g.content))); B.base=A.base;
  // A удаляет t2 (ставит надгробие), B правит t2
  edit(A, s=>{ s.transactions=s.transactions.filter(t=>t.id!=='t2'); s.tombstones['t2']=nextRev(); });
  edit(B, s=>{ const t=s.transactions.find(x=>x.id==='t2'); t.amount=999; });
  sync(A,g);                                    // push (только A менялся)
  sync(B,g);                                    // merge
  ok('удалённая t2 не воскресла после merge', txIds(B.state)==='t1', txIds(B.state)); })();

// 4) Повреждённое облако ({}) НЕ затирает локальные данные и НЕ перезаписывается молча.
(()=>{ const g={content:'{}'};
  const A=device('A', mkState({transactions:[{id:'t1',type:'expense',amount:100,currency:'KZT'}]})); edit(A,()=>{});
  const act=sync(A,g);
  ok('битое облако → corrupt (аборт)', act==='corrupt');
  ok('локальные данные A целы', txIds(A.state)==='t1');
  ok('битый gist НЕ перезаписан молча', g.content==='{}'); })();

// 5) Пустое облако (файла нет) → выгружаем локальное (push), данные появляются в облаке.
(()=>{ const g={content:null};
  const A=device('A', mkState({transactions:[{id:'t1',type:'expense',amount:100,currency:'KZT'}]})); edit(A,()=>{});
  const act=sync(A,g);
  ok('пустое облако → push', act==='push');
  ok('облако получило данные', C.isValidState(JSON.parse(g.content)) && JSON.parse(g.content).transactions.length===1); })();

// 6) null / массив / {} все отвергаются валидатором до любой записи.
(()=>{ ok('null отвергнут', !C.isValidState(null));
  ok('массив отвергнут', !C.isValidState([]));
  ok('{} отвергнут', !C.isValidState({})); })();

/* ---------------- вывод ---------------- */
let pass=0; for(const r of res){ console.log((r.ok?'  ✓ ':'  ✗ ')+r.name+(r.ok?'':'  — '+r.info)); if(r.ok)pass++; }
console.log(`\n${pass===res.length?'✓ ВСЕ ПРОЙДЕНЫ':'✗ ЕСТЬ ПАДЕНИЯ'}: ${pass}/${res.length} (интеграция синка)`);
if(pass!==res.length) Deno.exit(1);
