import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {MetalsProxy} from '../../src/research/metalsProxy.js';
import {MetalsObserver} from '../../src/research/metalsObserver.js';
const base=1800000000000;
function message(at,price=3801,extra={}) {return {type:'streamUpdated',subscriptionId:1,parsed:{priceFeeds:[{
  priceFeedId:346,price:String(Math.round(price*100000)),exponent:-5,confidence:1000,
  feedUpdateTimestamp:at*1000,marketSession:'regular',...extra}]}};}
test('spot proxy has signed YES/NO cushions and never claims official reference',()=>{
  const p=new MetalsProxy({now:()=>base});p.ingest(message(base));
  const s=p.snapshot('GOLD',3800,'yes');assert.equal(s.estimatedCushion,1);
  assert.equal(p.snapshot('GOLD',3800,'no').estimatedCushion,-1);
  assert.equal(s.officialReferencePrice,null);assert.equal(s.proxyIndexDifference,null);
  assert.equal(s.confidence,.01);assert.equal(s.referenceType,'SPOT_PROXY_NOT_SETTLEMENT');
  assert.equal(p.snapshot('GOLD',null,'yes').estimatedCushion,null);
});
test('stale, carried-forward, closed, future and malformed observations are unusable',()=>{
  for(const [at,extra] of [[base-2001,{}],[base+1,{}],[base,{marketSession:'closed'}],
    [base,{price:null}],[base,{exponent:null}],[base,{feedUpdateTimestamp:null}],
    [base,{price:'9007199254740992'}],[base,{priceFeedId:3712}]]) {
    const p=new MetalsProxy({now:()=>base});p.ingest(message(at,3801,extra));
    assert.equal(p.snapshot('GOLD',3800,'yes').status,'UNAVAILABLE_OR_STALE');
  }
  let now=base;const p=new MetalsProxy({now:()=>now});p.ingest(message(base));now+=2001;
  assert.equal(p.snapshot('GOLD',3800,'yes').estimatedCushion,null);
});
test('redundant and older source timestamps cannot replace current prices',()=>{
  const p=new MetalsProxy({now:()=>base});p.ingest(message(base));p.ingest(message(base,9999));
  p.ingest(message(base-1000,2));assert.equal(p.snapshot('GOLD',3800,'yes').price,3801);
});
test('15/30/60-second movements require complete elapsed history and reject gaps',()=>{
  let now=base;const p=new MetalsProxy({now:()=>now});
  for(let s=0;s<=60;s++){now=base+s*1000;p.ingest(message(now,3800+s));}
  const m=p.snapshot('GOLD',3800,'no').movement;
  for(const s of [15,30,60]){assert.equal(m[s].priceChange,s);assert.equal(m[s].range,s);assert.equal(m[s].cushionChange,-s);}
  now+=10000;p.ingest(message(now,3861));assert.equal(p.snapshot('GOLD',3800,'yes').movement[15],null);
});
test('source history stays bounded, and silver uses its own feed',()=>{
  let now=base;const p=new MetalsProxy({now:()=>now});
  for(let i=0;i<2000;i++){now=base+i*200;p.ingest(message(now,3801));}
  assert.ok(p.history.GOLD.length<=100);assert.equal(p.snapshot('SILVER',50,'yes').price,null);
  p.ingest(message(now,51,{priceFeedId:345}));assert.equal(p.snapshot('SILVER',50,'yes').estimatedCushion,1);
});
test('without a key no network is opened; all endpoints use headers and secrets are not logged',()=>{
  const opened=[],logs=[];
  class Socket extends EventEmitter {constructor(url,options){super();this.url=url;this.options=options;opened.push(this);}
    send(body){(this.bodies??=[]).push(JSON.parse(body));}terminate(){this.emit('close');}close(){this.emit('close');}}
  const p=new MetalsProxy({Socket,log:e=>logs.push(e)});p.start('');assert.equal(opened.length,0);
  p.start('private-test-key');assert.equal(opened.length,3);
  for(const s of opened){assert.equal(s.options.headers.Authorization,'Bearer private-test-key');s.emit('open');
    assert.deepEqual(s.bodies[0].priceFeedIds,[346,345]);assert.ok(s.bodies[0].properties.includes('feedUpdateTimestamp'));
    assert.deepEqual(s.bodies[1].priceFeedIds,[327,340]);}
  p.stop();assert.ok(!JSON.stringify(logs).includes('private-test-key'));
});
test('proxy measurements persist with hypothetical entries but never gate or alter sizing',async()=>{
  const market={ticker:'KXGOLD15M-TEST',status:'open',open_time:new Date(base-721000).toISOString(),
    close_time:new Date(base+179000).toISOString(),floor_strike:3800};
  const run=async(proxy)=>{
    const o=new MetalsObserver({now:()=>base,proxy,store:{load:()=>null,save:()=>{}},log:()=>{},
      read:async route=>route.startsWith('/series/')?{series:{ticker:'KXGOLD15M',frequency:'fifteen_min',fee_type:'quadratic',fee_multiplier:1}}:
        route.startsWith('/markets?')?{markets:[market]}:{orderbook_fp:{yes_dollars:[['.89','20']],no_dollars:[['.10','20']]}}});
    await o.discover('GOLD');await o.observe('GOLD');return o.state.markets[market.ticker].candidates[0];
  };
  const p=new MetalsProxy({now:()=>base});p.ingest(message(base,3790));
  const plain=await run(null), observed=await run(p);
  assert.equal(observed.estimatedCost,plain.estimatedCost);assert.equal(observed.count,plain.count);
  assert.equal(observed.proxy.estimatedCushion,-10);assert.equal(observed.distance,null);
  assert.equal(observed.proximity,'NOT_EVALUATED');assert.equal(observed.proxySide,'yes');
});
