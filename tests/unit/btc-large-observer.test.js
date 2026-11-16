import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BtcLargeObserver,evaluateBtcLarge,publicBtcObservationRead} from '../../src/research/btcLargeObserver.js';
const now=1800000000000;
const history=(side='yes')=>Array.from({length:326},(_,i)=>({sourceTs:now-65000+i*200,
  price:side==='yes'?38150+i*.02:37850-i*.02}));
const input=(side='yes')=>({history:history(side),quote:{source:'CF_BENCHMARKS',price:history(side).at(-1).price,
  sourceTs:now},target:38000,side,secondsRemaining:60,now,ticker:'KXBTC15M-TEST'});
test('both sides qualify on winning cushion and five elapsed increasing seconds',()=>{
  for(const side of ['yes','no']) {
    const c=evaluateBtcLarge(input(side));assert.equal(c.allowed,true);
    assert.equal(c.momentumCheckpoints.length,6);assert.ok(c.cushion>100);
  }
});
test('strict time, signed distance and fresh official reference fail closed',()=>{
  const i=input();
  for(const secondsRemaining of [90,0,-1])assert.equal(evaluateBtcLarge({...i,secondsRemaining}).allowed,false);
  assert.equal(evaluateBtcLarge({...i,target:i.quote.price-50}).reason,'CUSHION_NOT_ABOVE_50');
  assert.equal(evaluateBtcLarge({...i,side:'no'}).allowed,false);
  for(const quote of [null,{...i.quote,source:'BINANCE'},{...i.quote,sourceTs:now-2001},{...i.quote,sourceTs:now+1}])
    assert.equal(evaluateBtcLarge({...i,quote}).allowed,false);
});
test('requires continuous one-minute history and five improving intervals, not five messages',()=>{
  const i=input();
  assert.equal(evaluateBtcLarge({...i,history:i.history.slice(-25)}).allowed,false);
  assert.equal(evaluateBtcLarge({...i,history:i.history.filter(p=>p.sourceTs<now-10000||p.sourceTs>now-5000)}).allowed,false);
  const flat=i.history.map(p=>({...p,price:i.quote.price}));
  assert.equal(evaluateBtcLarge({...i,history:flat}).reason,'FIVE_SECOND_MOMENTUM_REQUIRED');
});
test('volatility cushion and first-entry shrinking guard are enforced',()=>{
  const i=input();const h=i.history.map((p,j)=>({...p,price:j===40?39000:p.price}));
  assert.equal(evaluateBtcLarge({...i,history:h}).reason,'VOLATILITY_CUSHION_TOO_SMALL');
  const falling=i.history.map((p,j)=>({...p,price:38500-j}));
  const c=evaluateBtcLarge({...i,history:falling,quote:{...i.quote,price:falling.at(-1).price}});
  assert.equal(c.allowed,false);assert.ok(c.guard);assert.notEqual(c.guard.allowed,true);
});
function fixture(price=.99,size=10000){
  let at=now,saved=null,result='',bookPrice=price,bookSize=size;
  const ticker='KXBTC15M-TEST',market={ticker,status:'active',floor_strike:38000,
    open_time:new Date(now-840000).toISOString(),close_time:new Date(now+60000).toISOString()};
  const logs=[],requests=[],store={load:()=>structuredClone(saved),save:s=>{saved=structuredClone(s);}};
  const read=async route=>{requests.push(route);if(route.startsWith('/series/'))return {series:{ticker:'KXBTC15M',frequency:'fifteen_min',fee_type:'quadratic',fee_multiplier:1}};
    if(route.includes('?series'))return {markets:[market]};
    if(route.includes('/orderbook'))return {orderbook_fp:{yes_dollars:[[String(bookPrice-.001),'10000']],no_dollars:[[String(1-bookPrice),String(bookSize)]]}};
    return {market:{...market,status:result?'finalized':'active',result}};};
  const feed={getHistory:()=>history().map(p=>({...p,sourceTs:p.sourceTs+at-now})),
    getQuote:()=>({...input().quote,sourceTs:at})};
  const make=()=>new BtcLargeObserver({feed,read,store,now:()=>at,log:e=>logs.push(e)});
  return {make,logs,requests,store,setAt:t=>{at=t;},setResult:r=>{result=r;},
    setBook:(p,s)=>{bookPrice=p;bookSize=s;}};
}
test('99.9-cent entries remain eligible, fees count, and displayed size limits the fill',async()=>{
  for(const price of [.99,.999,.9999]) {
    const f=fixture(price);const o=f.make();await o.tick();const c=o.state.markets['KXBTC15M-TEST'].candidate;
    assert.equal(c.price,price);assert.ok(c.estimatedCost<=2500);assert.ok(c.potentialNet>0);
  }
  const f=fixture(.999,20);const o=f.make();await o.tick();const c=o.state.markets['KXBTC15M-TEST'].candidate;
  assert.equal(c.count,20);assert.ok(c.unusedBudget>2400);assert.equal(c.fullBudgetFilled,false);
});
test('one hypothetical entry per window survives restart and settlement counts once',async()=>{
  const f=fixture();let o=f.make();await o.tick();await o.tick();o=f.make();await o.tick();
  assert.equal(f.logs.filter(e=>e.event==='CANDIDATE').length,1);
  f.setAt(now+65000);f.setResult('yes');await o.tick();
  assert.ok(o.state.totals.net>0);assert.equal(o.state.totals.entries,1);
  await f.make().tick();assert.equal(f.logs.filter(e=>e.event==='SETTLED_ESTIMATE').length,1);
  assert.ok(f.requests.every(r=>!r.includes('portfolio')&&!r.includes('orders')));
});
test('losing settlement charges the full fee-inclusive modeled spend',async()=>{
  const f=fixture();const o=f.make();await o.tick();const cost=o.state.markets['KXBTC15M-TEST'].candidate.estimatedCost;
  f.setAt(now+65000);f.setResult('no');await o.tick();assert.equal(o.state.totals.net,-cost);
});
test('observer adapter rejects non-public or unrelated paths before fetching',async()=>{
  for(const route of ['/portfolio/orders','/portfolio/balance','/markets/KXETH15M-TEST','/markets/KXBTC15M-TEST/orders'])
    await assert.rejects(publicBtcObservationRead(route),/not allowed/);
});
