import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BtcLargeObserver,publicBtcObservationRead} from '../../src/research/btcLargeObserver.js';

const now=1800000000000;
const ticker='KXBTC15M-TEST';
const market={ticker,status:'active',floor_strike:38000,
  open_time:new Date(now-840000).toISOString(),close_time:new Date(now+60000).toISOString()};

function fixture(initialState=null) {
  let at=now,saved=initialState,result='';
  const logs=[],requests=[];
  const store={load:()=>structuredClone(saved),save:s=>{saved=structuredClone(s);}};
  const read=async route=>{
    requests.push(route);
    if(route.startsWith('/series/'))return {series:{ticker:'KXBTC15M',
      frequency:'fifteen_min',fee_type:'quadratic',fee_multiplier:1}};
    if(route.includes('?series'))return {markets:[market]};
    if(route.includes('/orderbook'))return {orderbook_fp:{yes_dollars:[['.989','10000']],
      no_dollars:[['.01','10000']]}};
    return {market:{...market,status:result?'finalized':'active',result}};
  };
  const feed={getHistory:()=>Array.from({length:326},(_,i)=>({sourceTs:at-65000+i*200,
    price:38150+i*.02})),
  getQuote:()=>({source:'CF_BENCHMARKS',price:38156.5,sourceTs:at})};
  const make=()=>new BtcLargeObserver({feed,read,store,now:()=>at,log:e=>logs.push(e)});
  return {make,logs,requests,close:side=>{at=now+65000;result=side;}};
}

test('late research does not create a new large-entry estimate at 99 cents',async()=>{
  const f=fixture();const o=f.make();
  await o.tick();
  assert.ok(f.requests.some(route=>route.endsWith('/orderbook?depth=1')));
  assert.equal(o.state.markets[ticker].candidate,undefined);
  assert.ok(!f.logs.some(e=>['CHECK','CANDIDATE'].includes(e.event)));
});

test('existing large-entry estimate and wedge settle once across restarts',async()=>{
  for(const side of ['yes','no']) {
    const candidate={side:'yes',count:100,estimatedCost:99.5};
    const wedge={direction:'up'};
    const f=fixture({version:1,markets:{[ticker]:{ticker,closeTime:market.close_time,
      startedAt:now,feeMultiplier:1,candidate,wedgeSignals:[wedge]}},
    totals:{windows:0,entries:0,wins:0,losses:0,net:0}});
    f.close(side);
    const o=f.make();await o.tick();await f.make().tick();
    assert.equal(o.state.totals.net,side==='yes'?.5:-99.5);
    assert.equal(o.state.totals.entries,1);
    assert.equal(f.logs.filter(e=>e.event==='SETTLED_ESTIMATE').length,1);
    assert.equal(f.logs.filter(e=>e.event==='BTC_WEDGE_SETTLED').length,1);
    assert.equal(f.logs.find(e=>e.event==='BTC_WEDGE_SETTLED').signalMatchedSettlement,side==='yes');
  }
});

test('observer adapter rejects non-public or unrelated paths before fetching',async()=>{
  for(const route of ['/portfolio/orders','/portfolio/balance','/markets/KXETH15M-TEST','/markets/KXBTC15M-TEST/orders'])
    await assert.rejects(publicBtcObservationRead(route),/not allowed/);
});
