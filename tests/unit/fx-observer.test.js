import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {METALS,MetalsObserver,activeMetalMarket,publicMetalRead} from '../../src/research/metalsObserver.js';
import {MetalsProxy} from '../../src/research/metalsProxy.js';
const base=1800000000000;
const m=(asset)=>({ticker:METALS[asset]+'-TEST',status:'open',open_time:new Date(base-721000).toISOString(),
  close_time:new Date(base+179000).toISOString(),floor_strike:asset==='EURUSD'?1.1:159});
test('FX discovery identifies the exact independent fifteen-minute currency series',()=>{
  for(const asset of ['EURUSD','USDJPY']){
    assert.equal(activeMetalMarket([m('GOLD'),m(asset)],asset,base).ticker,m(asset).ticker);
    assert.equal(activeMetalMarket([{...m(asset),ticker:'KXBTC15M-TEST'}],asset,base),null);
  }
});
test('FX feed units and exponent scaling produce correct signed cushions and pips',()=>{
  const p=new MetalsProxy({now:()=>base});
  p.ingest({type:'streamUpdated',subscriptionId:2,parsed:{priceFeeds:[
    {priceFeedId:327,price:'110025',exponent:-5,feedUpdateTimestamp:base*1000,marketSession:'regular'},
    {priceFeedId:340,price:'159125',exponent:-3,feedUpdateTimestamp:base*1000,marketSession:'regular'}]}});
  const eur=p.snapshot('EURUSD',1.1,'yes'),jpy=p.snapshot('USDJPY',159.15,'no');
  assert.equal(eur.price,1.10025);assert.equal(eur.quoteUnit,'USD per EUR');
  assert.ok(Math.abs(eur.estimatedCushionPips-2.5)<1e-8);
  assert.equal(jpy.price,159.125);assert.equal(jpy.quoteUnit,'JPY per USD');
  assert.ok(Math.abs(jpy.estimatedCushionPips-2.5)<1e-8);
  assert.equal(eur.officialReferencePrice,null);
  assert.equal(p.snapshot('GOLD',3800,'yes').price,null);
});
test('missing target refresh preserves existing candidates and totals across restore',async()=>{
  const market=m('EURUSD');let saved={version:1,totals:{GOLD:{hypotheticalNet:7}},markets:{
    [market.ticker]:{asset:'EURUSD',ticker:market.ticker,closeTime:market.close_time,target:null,
      observations:[],candidates:[],side:null,result:null,feeType:'quadratic',feeMultiplier:1}}};
  const p=new MetalsProxy({now:()=>base});p.ingest({type:'streamUpdated',subscriptionId:2,parsed:{priceFeeds:[
    {priceFeedId:327,price:'110025',exponent:-5,feedUpdateTimestamp:base*1000,marketSession:'regular'}]}});
  const o=new MetalsObserver({now:()=>base,proxy:p,log:()=>{},store:{load:()=>saved,save:s=>{saved=structuredClone(s);}},
    read:async route=>route.includes('/orderbook')?{orderbook_fp:{yes_dollars:[['.89','100']],no_dollars:[['.1','100']]}}:{market}});
  o.current.EURUSD=market;await o.observe('EURUSD');
  assert.equal(saved.markets[market.ticker].target,1.1);assert.equal(saved.markets[market.ticker].candidates.length,1);
  assert.equal(saved.totals.GOLD.hypotheticalNet,7);
  assert.ok(Math.abs(saved.markets[market.ticker].candidates[0].proxy.estimatedCushionPips-2.5)<1e-8);
});
test('an FX subscription rejection cannot close the metals connection',()=>{
  const sockets=[],logs=[];
  class Socket extends EventEmitter{constructor(){super();sockets.push(this);}send(){}close(){this.closed=true;this.emit('close');}
    terminate(){this.emit('close');}}
  const p=new MetalsProxy({now:()=>base,Socket,log:e=>logs.push(e)}).start('test-secret');
  sockets[0].emit('message',Buffer.from(JSON.stringify({type:'subscriptionError',subscriptionId:2})));
  assert.equal(sockets[0].closed,undefined);assert.equal(logs.at(-1).subscriptionId,2);
  sockets[0].emit('message',Buffer.from(JSON.stringify({type:'streamUpdated',subscriptionId:1,parsed:{priceFeeds:[
    {priceFeedId:346,price:'380000000',exponent:-5,feedUpdateTimestamp:base*1000,marketSession:'regular'}]}})));
  assert.equal(p.snapshot('GOLD',3799,'yes').price,3800);p.stop();
});
test('public FX adapter permits only exact read routes and rejects arbitrary order endpoints',async()=>{
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({})};};
  try{
    for(const route of ['/series/KXEURUSD15M','/series/KXUSDJPY15M',
      '/markets/KXEURUSD15M-TEST/orderbook?depth=1','/markets/KXUSDJPY15M-TEST',
      '/markets?series_ticker=KXEURUSD15M&status=open&limit=100'])await publicMetalRead(route);
    assert.equal(requests.length,5);assert.ok(requests.every(x=>x.options.method==='GET'));
    for(const route of ['/portfolio/orders','/markets/KXEURUSD15M-TEST/orders',
      '/series/KXCOPPER15M','/markets?series_ticker=KXBTC15M&status=open&limit=100'])await assert.rejects(publicMetalRead(route));
    assert.equal(requests.length,5);
  }finally{globalThis.fetch=original;}
});
