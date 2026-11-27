import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { evaluateLateProximity, LATE_MIN_DISTANCE_USD } from '../../src/engine/lateProximity.js';
import { BenchmarkFeed } from '../../src/prices/cfBenchmarks.js';

const now=1800000000000;
const quote=price=>({price,source:'CF_BENCHMARKS',sourceTs:now,receivedAt:now});
test('all stage and side proximity boundaries use signed dollars, including equality',()=>{
  for(const [asset,stages] of Object.entries(LATE_MIN_DISTANCE_USD)) for(const [stageId,min] of Object.entries(stages)) {
    const target=asset==='BTC'?65000:2000;
    for(const side of ['yes','no']) for(const delta of [-.01,0,.01]) {
      const price=target+(side==='yes'?1:-1)*(min+delta);
      const r=evaluateLateProximity({asset,stageId,side,target,quote:quote(price),now});
      assert.equal(r.allowed,delta>=0,`${asset} ${stageId} ${side} ${delta}`);
    }
    for(const side of ['yes','no']) {
      const price=target+(side==='yes'?-1:1)*1000;
      assert.equal(evaluateLateProximity({asset,stageId,side,target,quote:quote(price),now}).allowed,false);
    }
  }
});
test('BTC wick entries require $50 only when more than two minutes remain', () => {
  const target = 59700.43;
  for (const side of ['yes', 'no']) {
    const direction = side === 'yes' ? 1 : -1;
    const check = (distance, secondsRemaining, stageId = 'wick_5s') =>
      evaluateLateProximity({ asset: 'BTC', stageId, side, target,
        quote: quote(target + direction * distance), secondsRemaining, now });

    const early = check(49.26, 144.378);
    assert.equal(early.allowed, false);
    assert.equal(early.entryMinimumDistance, 50);
    assert.equal(early.minimumDistance, 30);
    assert.equal(check(49.99, 120.001).allowed, false);
    assert.equal(check(50, 120.001).allowed, true);
    assert.equal(check(30, 120).allowed, true);
    assert.equal(check(29.99, 119.999).allowed, false);
    assert.equal(check(30, 150, 'under_180').allowed, true);
  }
});
test('missing, stale, future, malformed and substitute-feed prices cannot authorize a buy',()=>{
  for(const q of [null,{...quote(65100),source:'BINANCE'}, {...quote(65100),price:NaN},
    {...quote(65100),sourceTs:now-2001},{...quote(65100),receivedAt:now-2001},
    {...quote(65100),sourceTs:now+1},{...quote(65100),receivedAt:now+1}]) {
    assert.equal(evaluateLateProximity({asset:'BTC',stageId:'under_60',side:'yes',target:65000,quote:q,now}).allowed,false);
  }
  for(const target of [null,NaN,0,-1,'65000']) assert.equal(evaluateLateProximity({asset:'BTC',stageId:'under_60',side:'yes',target,quote:quote(65100),now}).allowed,false);
});
test('benchmark ingestion validates source timestamps and never lets duplicates refresh freshness',()=>{
  let clock=now;const f=new BenchmarkFeed({now:()=>clock,log:()=>{}});
  const frame=(index_id,value_usd,source_ts_ms=clock)=>({type:'cfbenchmarks_value_5hz',msg:{index_id,value_usd,source_ts_ms}});
  assert.equal(f.ingest(frame('BRTI','65050.00000000')),true);
  assert.equal(f.ingest(frame('ETHUSD_RTI','2001.00000000')),true);
  assert.equal(f.getQuote('BTC').price,65050);assert.equal(f.getQuote('ETH').price,2001);
  clock+=1500;assert.equal(f.ingest(frame('BRTI','65060',now)),false);
  assert.equal(f.ingest(frame('BRTI','65060',now-1)),false);
  assert.equal(f.ingest(frame('BRTI','65060',clock+1)),false);
  assert.equal(f.ingest(frame('BRTI','garbage')),false);
  assert.equal(f.ingest(frame('BTC','65050')),false);
  clock+=501;assert.equal(f.getQuote('BTC'),null);
});
test('reference socket subscribes to the required indices and clears quotes immediately on disconnect',()=>{
  class Socket extends EventEmitter {
    constructor(url,opts){super();this.url=url;this.opts=opts;Socket.last=this;}
    send(s){this.sent=JSON.parse(s);}
    pong(){this.ponged=true;}
    terminate(){this.emit('close');}
  }
  const f=new BenchmarkFeed({Socket,headers:()=>({test:'auth'}),now:()=>now,log:()=>{}});
  f.connect();const ws=Socket.last;ws.emit('open');
  assert.deepEqual(ws.sent.params,{channels:['cfbenchmarks_value_5hz'],index_ids:['BRTI','ETHUSD_RTI']});
  ws.emit('message',Buffer.from(JSON.stringify({type:'cfbenchmarks_value_5hz',msg:{index_id:'BRTI',value_usd:'65050.00000000',source_ts_ms:now}})));
  assert.equal(f.getQuote('BTC').price,65050);
  ws.emit('ping');assert.equal(ws.ponged,true);
  assert.equal(f.getHistory('BTC').length,1);
  ws.emit('close');assert.equal(f.getQuote('BTC'),null);assert.deepEqual(f.getHistory('BTC'),[]);
  f.close();assert.equal(f.reconnectTimer,null);assert.equal(f.watchdog,null);
});
