import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createScalpExecutor,lateFee} from '../../src/engine/scalpExecution.js';
import {LIVE_LATE_MARKETS,MANAGED_ASSETS} from '../../src/engine/lateMarkets.js';
import {LateMarketRunner} from '../../src/engine/lateMarketRunner.js';
process.env.SCALP_ENABLED='true';process.env.DRY_RUN='false';
process.env.LATE_MARKETS_LIVE_ENABLED='true';
function fixture() {
  const now=Date.now(),shared={simMode:false,paperBalance:1000,balance:1000,disabledAssets:['ETH']};
  for(const asset of MANAGED_ASSETS)shared[asset]={ticker:(LIVE_LATE_MARKETS[asset]?.series??'KXBTC15M')+'-TEST',
    activeTrade:null,farmArmed:true,lastExitTime:0,lastLossTime:0,consecutiveLosses:0,
    sessionStartBalance:null,dailyStartBalance:null,sessionPnL:0,dailyPnL:0,totalPnL:0,tradeCount:0,
    marketCloseTs:now+170000,yesAsk:.90,yesBid:.89,lastQuoteMessageTs:now,
    lateFeeType:'quadratic',lateFeeMultiplier:1,yesAskSize:1000,noAskSize:1000};
  const requests=[],balances=[],logs=[];let saved=null,retry=now;
  const proxy={snapshot:()=>({status:'FRESH_PROXY',price:2010,sourceAt:Date.now()}),
    history:Object.fromEntries(Object.keys(LIVE_LATE_MARKETS).map(a=>[a,
      Array.from({length:151},(_,i)=>({sourceAt:now-30000+i*200,price:2010}))]))};
  const refresh=async asset=>{const s=shared[asset];s.lastQuoteMessageTs=Date.now();
    s.lateBook={yes:{price:s.yesAsk,size:s.yesAskSize},no:{price:1-s.yesBid,size:s.noAskSize}};};
  // Keep latest snapshot/history identical, with fresh contiguous data for every check.
  proxy.snapshot=asset=>{const at=Date.now();proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,price:2010}));
    return {status:'FRESH_PROXY',sourceAt:at,price:2010};};
  const api={getMarket:async ticker=>{
    const asset=Object.keys(LIVE_LATE_MARKETS).find(a=>ticker.startsWith(LIVE_LATE_MARKETS[a].series+'-'));
    const close=shared[asset].marketCloseTs;
    return {ticker,status:'open',strike_type:'greater_or_equal',floor_strike:2000,
      exchange_index:LIVE_LATE_MARKETS[asset].exchangeIndex,
      open_time:new Date(close-900000).toISOString(),close_time:new Date(close).toISOString()};
  },getPositions:async()=>MANAGED_ASSETS.flatMap(a=>{const t=shared[a].activeTrade;
    return t&&!t.sim?[{ticker:t.ticker,position_fp:String(t.side==='yes'?t.count:-t.count)}]:[];}),
    getOrders:async()=>[],getBalance:async index=>{balances.push(index);return 100000;},
    placeOrder:async body=>{requests.push({...body});return {order_id:'order-'+requests.length,
      fill_count:body.count,remaining_count:'0.00',average_fill_price:body.price,average_fee_paid:'0.0100'};}};
  const executor=createScalpExecutor({state:shared,api:Object.fromEntries(['getMarket','getPositions','getOrders','getBalance','placeOrder','getOrder','getAllFills','getAllSettlements'].map(k=>[k,(...args)=>api[k](...args)])),now:()=>retry,
    save:value=>saved=structuredClone(value),log:event=>logs.push(event)});
  const ctx=asset=>({asset,s:shared[asset],balance:1000,proxy,refreshQuote:()=>refresh(asset)});
  return {shared,requests,balances,logs,api,proxy,executor,ctx,saved:()=>saved,advance:()=>retry+=3001};
}
test('four markets buy with their own cash shard and coexist, restore holdings and budgets',async()=>{
  const f=fixture();
  for(const asset of Object.keys(LIVE_LATE_MARKETS))await f.executor.tick(f.ctx(asset));
  assert.equal(f.requests.length,4,JSON.stringify(f.logs));
  assert.deepEqual(f.balances,[2,2,0,0]);
  assert.deepEqual(f.requests.map(b=>b.exchange_index),[2,2,0,0]);
  for(const asset of Object.keys(LIVE_LATE_MARKETS)) {
    assert.equal(f.shared[asset].activeTrade.mode,'LATE_SETTLEMENT');
    assert.ok(f.shared[asset].activeTrade.originalCost<=2);
  }
  const g=fixture();g.executor.restore(f.saved());
  assert.equal(g.shared.USDJPY.activeTrade.count,2);
  assert.equal(g.executor.snapshot().lateStages[f.shared.GOLD.ticker].spent,1.82);
  assert.ok(g.shared.GOLD.sessionStartBalance>0);
});
test('every tier uses the requested fee-inclusive incremental budget',async()=>{
  for(const [seconds,price,budget] of [[170,.90,2],[140,.93,5],[110,.95,25],[55,.97,50],[40,.98,100]]) {
    const f=fixture();f.shared.GOLD.marketCloseTs=Date.now()+seconds*1000;
    f.shared.GOLD.yesAsk=price;f.shared.GOLD.yesBid=price-.01;
    await f.executor.tick(f.ctx('GOLD'));
    assert.equal(f.requests.length,1,JSON.stringify(f.logs));
    const b=f.requests[0],n=Number(b.count);
    assert.ok(n*price+lateFee(n,price)<=budget+1e-9);
    assert.equal(f.saved().pending,null);
  }
});
test('new markets never use BTC fixed distance: small positive proxy cushion qualifies',async()=>{
  const f=fixture();f.proxy.snapshot=asset=>{
    const at=Date.now();f.proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,price:2000.0001}));
    return {status:'FRESH_PROXY',sourceAt:at,price:2000.0001};};
  await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,1,JSON.stringify(f.logs));
});
test('stale feed, wrong winning side, missing continuous history and wrong exchange all block',async()=>{
  for(const defect of ['stale','losing','history','exchange']) {
    const f=fixture(),base=f.proxy.snapshot;
    if(defect==='stale')f.proxy.snapshot=()=>({status:'STALE_PROXY'});
    if(defect==='losing')f.proxy.snapshot=()=>({status:'FRESH_PROXY',sourceAt:Date.now(),price:1999});
    if(defect==='history')f.proxy.snapshot=asset=>{const p=base(asset);f.proxy.history[asset]=[];return p;};
    if(defect==='exchange'){const get=f.api.getMarket;f.api.getMarket=async t=>({...await get(t),exchange_index:0});}
    await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,0,defect);
  }
});
test('initial purchase is blocked by rapid shrinking cushion',async()=>{
  const f=fixture();f.proxy.snapshot=asset=>{const at=Date.now();
    f.proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,price:2020-i*.1}));
    return {status:'FRESH_PROXY',sourceAt:at,price:2005};};
  await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,0);
  assert.ok(f.logs.some(e=>e.shrinkingGuard&&!e.shrinkingGuard.allowed));
});
test('zero available exchange cash and unknown positions block; unrelated sports do not',async()=>{
  for(const defect of ['cash','position','sports']) {
    const f=fixture();
    if(defect==='cash')f.api.getBalance=async()=>0;
    else f.api.getPositions=async()=>[{ticker:defect==='sports'?'KXNFL-TEST':'KXGOLD15M-UNKNOWN',position_fp:'1'}];
    await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,defect==='sports'?1:0,defect);
  }
});
test('partial fills retain unused stage budget; uncertain orders block other assets',async()=>{
  const f=fixture();f.api.placeOrder=async body=>{f.requests.push(body);return {
    order_id:'partial',fill_count:'1.00',remaining_count:'0.00',average_fill_price:body.price,average_fee_paid:'0.0100'};};
  await f.executor.tick(f.ctx('GOLD'));assert.equal(f.shared.GOLD.activeTrade.count,1);
  assert.ok(f.saved().lateStages[f.shared.GOLD.ticker].records.under_180.spent<2);
  const g=fixture();g.api.placeOrder=async body=>{g.requests.push(body);throw new Error('timeout');};
  await g.executor.tick(g.ctx('GOLD'));assert.ok(g.saved().pending);
  await g.executor.tick(g.ctx('EURUSD'));assert.equal(g.requests.length,1);
});
test('disable flag and DRY_RUN prevent new real orders, and completed stages cannot duplicate',async()=>{
  const f=fixture();process.env.LATE_MARKETS_LIVE_ENABLED='false';
  try{await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,0);}
  finally{process.env.LATE_MARKETS_LIVE_ENABLED='true';}
  process.env.DRY_RUN='true';
  try{await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,0);assert.equal(f.shared.GOLD.activeTrade.sim,true);}
  finally{process.env.DRY_RUN='false';}
  const g=fixture();await g.executor.tick(g.ctx('GOLD'));g.advance();
  await g.executor.tick(g.ctx('GOLD'));assert.equal(g.requests.length,1);
});
test('runner still services restored holdings without an open market or feed',async()=>{
  const f=fixture(),seen=[];f.shared.GOLD.activeTrade={mode:'LATE_SETTLEMENT',ticker:'old'};
  const observer={current:{},series:{},proxy:null};
  const runner=new LateMarketRunner(observer,{shared:f.shared,executor:{tick:async c=>seen.push(c.asset)},log:()=>{}});
  await runner.tick();assert.deepEqual(seen,['GOLD']);
});
test('all five stages can fill once within $182; restored sequence never rebuys a spent tier',async()=>{
  const realNow=Date.now,base=realNow();let clock=base;
  Date.now=()=>clock;
  try {
    const f=fixture();
    for(const [elapsed,price] of [[0,.90],[30000,.93],[60000,.95],[115000,.97],[130000,.98]]) {
      clock=base+elapsed;f.advance();f.shared.GOLD.yesAsk=price;f.shared.GOLD.yesBid=price-.01;
      await f.executor.tick(f.ctx('GOLD'));
    }
    assert.equal(f.requests.length,5,JSON.stringify(f.logs));
    const t=f.shared.GOLD.activeTrade;assert.ok(t.originalCost<=182);
    assert.equal(f.saved().lateStages[t.ticker].attempted.length,5);
    f.advance();await f.executor.tick(f.ctx('GOLD'));assert.equal(f.requests.length,5);
  }finally{Date.now=realNow;}
});
test('settlement records actual tracked profit and persists cleared position and risk together',async()=>{
  const f=fixture();await f.executor.tick(f.ctx('EURUSD'));
  const t=f.shared.EURUSD.activeTrade;
  f.api.getMarket=async ticker=>({ticker,status:'finalized',result:'yes'});
  f.api.getPositions=async()=>[];
  f.api.getAllSettlements=async()=>[{ticker:t.ticker,settled_time:new Date(t.startedAt+1000).toISOString(),market_result:'yes'}];
  f.api.getAllFills=async()=>[];
  await f.executor.tick(f.ctx('EURUSD'));
  assert.equal(f.shared.EURUSD.activeTrade,null,JSON.stringify(f.logs));
  assert.equal(f.saved().positions.EURUSD,null);
  assert.ok(Math.abs(f.saved().marketRisk.EURUSD.dailyPnL-.18)<1e-8);
  assert.equal(f.saved().lateStages[t.ticker].closed,true);
});
test('displayed liquidity limits actual requests and a price change during account checks cancels entry',async()=>{
  const f=fixture();f.shared.SILVER.yesAskSize=1;
  await f.executor.tick(f.ctx('SILVER'));assert.equal(f.requests[0].count,'1.00');
  const g=fixture();let reads=0;
  g.api.getOrders=async()=>{if(++reads===2){g.shared.GOLD.yesAsk=.91;g.shared.GOLD.yesBid=.90;}return [];};
  await g.executor.tick(g.ctx('GOLD'));assert.equal(g.requests.length,0);
});
test('NO entry uses NO-side cushion and YES-book ask order conversion',async()=>{
  const f=fixture();f.shared.USDJPY.yesAsk=.11;f.shared.USDJPY.yesBid=.10;
  f.proxy.snapshot=asset=>{const at=Date.now();f.proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,price:1990}));
    return {status:'FRESH_PROXY',sourceAt:at,price:1990};};
  await f.executor.tick(f.ctx('USDJPY'));
  assert.equal(f.requests.length,1,JSON.stringify(f.logs));
  assert.equal(f.requests[0].side,'ask');assert.equal(f.requests[0].price,'0.1000');
  assert.equal(f.shared.USDJPY.activeTrade.side,'no');
  assert.ok(Math.abs(f.shared.USDJPY.activeTrade.entrySidePrice-.9)<1e-9);
});
test('restored daily-loss cap blocks additions before sending another order',async()=>{
  const f=fixture();await f.executor.tick(f.ctx('GOLD'));const saved=f.saved();
  saved.marketRisk.GOLD.dailyPnL=-100;saved.marketRisk.GOLD.dailyStartBalance=1000;
  const g=fixture();g.executor.restore(saved);g.advance();
  g.shared.GOLD.yesAsk=.95;g.shared.GOLD.yesBid=.94;
  await g.executor.tick(g.ctx('GOLD'));assert.equal(g.requests.length,0);
  assert.ok(g.logs.some(e=>e.reason==='DAILYCAP'),JSON.stringify(g.logs));
});
test('runner rejects delayed books and copies executable sizes only from fresh data',async()=>{
  const f=fixture();let now=Date.now();
  const observer={current:{GOLD:{ticker:f.shared.GOLD.ticker,status:'open'}},series:{},
    read:async()=>({orderbook_fp:{yes_dollars:[['0.89','5']],no_dollars:[['0.10','3']]}})};
  const runner=new LateMarketRunner(observer,{shared:f.shared,now:()=>now,log:()=>{}});
  await runner.refreshQuote('GOLD');assert.equal(f.shared.GOLD.yesAskSize,3);
  observer.read=async()=>{now+=2001;return {orderbook_fp:{yes_dollars:[['0.89','5']],no_dollars:[['0.10','3']]}};};
  await assert.rejects(()=>runner.refreshQuote('GOLD'),/STALE_RESPONSE/);
  assert.equal(f.shared.GOLD.lastQuoteMessageTs,0);
});
test('one-sided YES and NO books pass the full guarded executor without invented quotes',async()=>{
  for(const asset of Object.keys(LIVE_LATE_MARKETS))for(const side of ['yes','no']) {
    const f=fixture(),s=f.shared[asset];
    const raw={orderbook_fp:{yes_dollars:side==='no'?[['0.0100','10.00']]:[],
      no_dollars:side==='yes'?[['0.0100','10.00']]:[]}};
    if(side==='no')f.proxy.snapshot=a=>{const at=Date.now();f.proxy.history[a]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,price:1990}));return {status:'FRESH_PROXY',sourceAt:at,price:1990};};
    const runner=new LateMarketRunner({current:{[asset]:{ticker:s.ticker,status:'open'}},read:async()=>raw},
      {shared:f.shared,log:()=>{}});
    const ctx={...f.ctx(asset),refreshQuote:()=>runner.refreshQuote(asset)};
    await f.executor.tick(ctx);
    assert.equal(f.requests.length,1,asset+' '+side+' '+JSON.stringify(f.logs));
    const b=f.requests[0];assert.equal(b.side,side==='yes'?'bid':'ask');
    assert.equal(b.price,side==='yes'?'0.9900':'0.0100');
    assert.equal(s.activeTrade.side,side);assert.ok(s.activeTrade.originalCost<=2);
    assert.equal(side==='yes'?s.yesBid:s.yesAsk,null);
  }
});
test('directional path still blocks empty, crossed, stale, sub-contract and below-threshold liquidity',async()=>{
  for(const defect of ['empty','crossed','stale','fraction','cheap']) {
    const f=fixture(),s=f.shared.GOLD;let now=Date.now();
    const raw=defect==='empty'?{orderbook_fp:{yes_dollars:[],no_dollars:[]}}:
      defect==='crossed'?{orderbook_fp:{yes_dollars:[['0.7000','10']],no_dollars:[['0.4000','10']]}}:
      {orderbook_fp:{yes_dollars:[],no_dollars:[[defect==='cheap'?'0.1100':'0.0100',defect==='fraction'?'0.50':'10']]}};
    const runner=new LateMarketRunner({current:{GOLD:{ticker:s.ticker,status:'open'}},
      read:async()=>{if(defect==='stale')now+=2001;return raw;}},{shared:f.shared,now:()=>now,log:()=>{}});
    await f.executor.tick({...f.ctx('GOLD'),refreshQuote:()=>runner.refreshQuote('GOLD')});
    assert.equal(f.requests.length,0,defect);
    if(['empty','crossed','stale'].includes(defect))assert.ok(f.logs.some(e=>e.error?.includes('EXECUTABLE_BOOK_')),defect);
  }
});
test('selected-side liquidity disappearing on final recheck prevents an order',async()=>{
  const f=fixture(),s=f.shared.GOLD;let reads=0;
  const runner=new LateMarketRunner({current:{GOLD:{ticker:s.ticker,status:'open'}},read:async()=>({
    orderbook_fp:{yes_dollars:[['0.9800','10']],no_dollars:++reads<3?[['0.0100','10']]:[]}
  })},{shared:f.shared,log:()=>{}});
  await f.executor.tick({...f.ctx('GOLD'),refreshQuote:()=>runner.refreshQuote('GOLD')});
  assert.equal(f.requests.length,0);assert.equal(reads,3);
});

import {silverEntryBuffer} from '../../src/engine/silverEntryBuffer.js';
test('silver crossing buffer blocks a 13-second margin, equality, and respects source age',()=>{
  const now=Date.now(),check={allowed:true,reason:'SHRINK_OK',sourceTs:now,
    approachUsdPerSecond:.001,projectedSecondsToTarget:70,stabilized:true};
  assert.equal(silverEntryBuffer(check,'SILVER',57,now).allowed,false);
  assert.equal(silverEntryBuffer(check,'SILVER',50,now).allowed,false);
  assert.equal(silverEntryBuffer(check,'SILVER',49,now).allowed,true);
  const older={...check,sourceTs:now-1500};
  assert.equal(silverEntryBuffer(older,'SILVER',49,now).allowed,false);
  assert.equal(silverEntryBuffer(check,'SILVER',57,now).reason,'SILVER_CROSSING_TIME_BUFFER');
});
test('silver buffer cannot be cleared by stabilization alone or bypass existing blocked checks',()=>{
  const now=Date.now(),check={allowed:true,reason:'SHRINK_OK',sourceTs:now,
    approachUsdPerSecond:.001,projectedSecondsToTarget:70,stabilized:true};
  assert.equal(silverEntryBuffer(check,'SILVER',57,now).allowed,false);
  const blocked={...check,allowed:false,reason:'SHRINK_RAPID_APPROACH'};
  assert.equal(silverEntryBuffer(blocked,'SILVER',10,now),blocked);
  for(const a of ['BTC','GOLD','USDJPY'])assert.equal(silverEntryBuffer(check,a,57,now),check);
  assert.equal(silverEntryBuffer({...check,approachUsdPerSecond:0,projectedSecondsToTarget:null},'SILVER',57,now).allowed,true);
  assert.equal(silverEntryBuffer({...check,projectedSecondsToTarget:NaN},'SILVER',57,now).allowed,false);
});
test('silver delays a marginal entry and resumes when the projection clears the buffer',async()=>{
  const f=fixture(),s=f.shared.SILVER; s.marketCloseTs=Date.now()+57000;s.yesAsk=.98;s.yesBid=.97;
  let projection=70;
  f.proxy.snapshot=asset=>{const at=Date.now(),speed=10/projection;
    f.proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,
      price:2010+speed*(30-i*.2)}));
    return {status:'FRESH_PROXY',sourceAt:at,price:2010};};
  await f.executor.tick(f.ctx('SILVER'));
  assert.equal(f.requests.length,0,JSON.stringify(f.logs));
  assert.ok(f.logs.some(e=>e.reason==='SILVER_CROSSING_TIME_BUFFER'));
  projection=100;f.advance();await f.executor.tick(f.ctx('SILVER'));
  assert.equal(f.requests.length,1,JSON.stringify(f.logs));
  assert.ok(f.logs.find(e=>e.event==='ENTRY_CONFIRMED').shrinkingGuard.projectedMarginSeconds>20);
});
test('silver buffer also delays NO purchases and rechecks after account reads',async()=>{
  for(const finalOnly of [false,true]) {
    const f=fixture(),s=f.shared.SILVER;s.marketCloseTs=Date.now()+57000;
    s.yesAsk=.03;s.yesBid=.02;let projection=finalOnly?100:70;
    f.proxy.snapshot=asset=>{const at=Date.now(),speed=10/projection;
      f.proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,
        price:1990-speed*(30-i*.2)}));
      return {status:'FRESH_PROXY',sourceAt:at,price:1990};};
    let accountReads=0;f.api.getOrders=async()=>{if(++accountReads===2)projection=70;return [];};
    await f.executor.tick(f.ctx('SILVER'));
    assert.equal(f.requests.length,0,JSON.stringify(f.logs));
    assert.ok(f.logs.some(e=>e.reason==='SILVER_CROSSING_TIME_BUFFER'));
    if(finalOnly)assert.equal(accountReads,2);
  }
});
test('EUR/USD requires more than 15 seconds while silver still requires more than 20',()=>{
  const now=Date.now(),base={allowed:true,reason:'SHRINK_OK',sourceTs:now,
    approachUsdPerSecond:.000001,projectedSecondsToTarget:41.25,stabilized:true};
  assert.equal(silverEntryBuffer(base,'EURUSD',37,now).allowed,false);
  assert.equal(silverEntryBuffer({...base,projectedSecondsToTarget:52},'EURUSD',37,now).allowed,false);
  const wider={...base,projectedSecondsToTarget:53};
  assert.equal(silverEntryBuffer(wider,'EURUSD',37,now).allowed,true);
  assert.equal(silverEntryBuffer(wider,'SILVER',37,now).allowed,false);
  assert.equal(silverEntryBuffer({...wider,sourceTs:now-1500},'EURUSD',37,now).allowed,false);
  assert.equal(silverEntryBuffer(base,'EURUSD',37,now).reason,'EURUSD_CROSSING_TIME_BUFFER');
  assert.equal(silverEntryBuffer(base,'EURUSD',37,now).entryTimeBufferSeconds,15);
  assert.equal(silverEntryBuffer({...base,sourceTs:now-2001},'EURUSD',37,now).allowed,false);
  assert.equal(silverEntryBuffer({...base,approachUsdPerSecond:0,projectedSecondsToTarget:null},'EURUSD',37,now).allowed,true);
  const blocked={...base,allowed:false,reason:'SHRINK_PROJECTED_CROSSING'};
  assert.equal(silverEntryBuffer(blocked,'EURUSD',10,now),blocked);
});
test('EUR/USD delays YES and NO final-stage entries until projection moves beyond 15 seconds',async()=>{
  for(const side of ['yes','no']) {
    const f=fixture(),s=f.shared.EURUSD;s.marketCloseTs=Date.now()+37000;
    s.yesAsk=side==='yes'?.98:.03;s.yesBid=side==='yes'?.97:.02;
    let projection=41.25;
    f.proxy.snapshot=asset=>{const at=Date.now(),speed=.001/projection,sign=side==='yes'?1:-1;
      f.proxy.history[asset]=Array.from({length:151},(_,i)=>({sourceAt:at-30000+i*200,
        price:2000+sign*(.001+speed*(30-i*.2))}));
      return {status:'FRESH_PROXY',sourceAt:at,price:2000+sign*.001};};
    await f.executor.tick(f.ctx('EURUSD'));assert.equal(f.requests.length,0,JSON.stringify(f.logs));
    assert.ok(f.logs.some(e=>e.reason==='EURUSD_CROSSING_TIME_BUFFER'));
    projection=65;f.advance();await f.executor.tick(f.ctx('EURUSD'));
    assert.equal(f.requests.length,1,JSON.stringify(f.logs));
    assert.equal(s.activeTrade.side,side);
    const check=f.logs.find(e=>e.event==='ENTRY_CONFIRMED').shrinkingGuard;
    assert.equal(check.entryTimeBufferSeconds,15);assert.ok(check.projectedMarginSeconds>15);
  }
});
