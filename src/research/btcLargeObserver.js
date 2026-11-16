import fs from 'node:fs';
import path from 'node:path';
import {metalBook,estimateMetalEntry} from './metalsObserver.js';
import {evaluateShrinkingCushion} from '../engine/shrinkingCushion.js';

// Research only. No authenticated client, order submission, or trading-state mutation.
export const BTC_LARGE_RULES={budget:2500,maxSeconds:90,minPrice:.99,
  minimumCushion:50,momentumSeconds:2,rangeSeconds:60,rangeMultiple:1.5,
  maxReferenceAgeMs:2000,maxBookAgeMs:2000};
const BASE='https://api.elections.kalshi.com/trade-api/v2';
export async function publicBtcObservationRead(route) {
  if(route!=='/series/KXBTC15M'&&route!=='/markets?series_ticker=KXBTC15M&status=open&limit=100'&&
    !/^\/markets\/KXBTC15M-[A-Z0-9-]+(?:\/orderbook\?depth=1)?$/.test(route))
    throw new Error('BTC observer route not allowed');
  const response=await fetch(BASE+route,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('BTC observer public read HTTP '+response.status);
  return response.json();
}
export function btcLargeStore(directory=path.join(process.env.SCALP_STATE_DIR??'data','btc-large-observer')) {
  const file=path.join(directory,'state.json');
  return {load(){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    save(value){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file);}};
}
export function evaluateBtcLarge({history,quote,target,side,secondsRemaining,now,previous=null,ticker}) {
  const reject=(reason,detail={})=>({allowed:false,reason,...detail});
  if(!(secondsRemaining>0&&secondsRemaining<90))return reject('OUTSIDE_TIME');
  if(!Number.isFinite(target)||target<=0||!['yes','no'].includes(side))return reject('INVALID_TARGET_OR_SIDE');
  if(quote?.source!=='CF_BENCHMARKS'||!Number.isFinite(quote.price)||
    !Number.isSafeInteger(quote.sourceTs)||now-quote.sourceTs<0||now-quote.sourceTs>2000)
    return reject('REFERENCE_UNAVAILABLE');
  const sign=side==='yes'?1:-1,cushion=sign*(quote.price-target);
  if(cushion<=50)return reject('CUSHION_NOT_ABOVE_50',{cushion});
  const rows=(history??[]).filter(p=>Number.isSafeInteger(p.sourceTs)&&p.sourceTs<=now&&
    Number.isFinite(p.price)&&p.price>0).sort((a,b)=>a.sourceTs-b.sourceTs);
  const last=rows.at(-1),point=t=>rows.findLast(p=>p.sourceTs<=t&&t-p.sourceTs<=500);
  if(!last||last.sourceTs!==quote.sourceTs)return reject('HISTORY_UNAVAILABLE',{cushion});
  const first=point(last.sourceTs-60000),recent=first?rows.filter(p=>p.sourceTs>=first.sourceTs):[];
  if(!first||recent.some((p,i)=>i&&p.sourceTs-recent[i-1].sourceTs>1500))
    return reject('SIXTY_SECOND_HISTORY_REQUIRED',{cushion});
  const range60=Math.max(...recent.map(p=>p.price))-Math.min(...recent.map(p=>p.price));
  const guard=evaluateShrinkingCushion({history:rows,asset:'BTC',ticker,side,target,minimumDistance:50,
    rapidDropMinimum:50,secondsRemaining,previous,now});
  const detail={cushion,range60,requiredCushion:Math.max(50,1.5*range60),guard};
  if(!guard.allowed)return reject(guard.reason,detail);
  if(cushion<1.5*range60)return reject('VOLATILITY_CUSHION_TOO_SMALL',detail);
  const checkpoints=Array.from({length:3},(_,i)=>point(last.sourceTs-(2-i)*1000));
  if(checkpoints.some(p=>!p)||checkpoints.some((p,i)=>i&&sign*(p.price-checkpoints[i-1].price)<=1e-9))
    return reject('TWO_SECOND_MOMENTUM_REQUIRED',detail);
  return {allowed:true,reason:'QUALIFIED',...detail,momentumCheckpoints:checkpoints,
    referencePrice:quote.price,referenceSourceTs:quote.sourceTs};
}

export class BtcLargeObserver {
  constructor({feed,read=publicBtcObservationRead,store=btcLargeStore(),now=Date.now,
    log=e=>console.log('[BTC_LARGE_OBSERVER] '+JSON.stringify(e))}={}) {
    Object.assign(this,{feed,read,store,now,log});
    this.state=store.load()??{version:1,markets:{},totals:{windows:0,entries:0,wins:0,losses:0,net:0}};
    if(this.state.version!==1||!this.state.markets||!this.state.totals)throw new Error('Invalid BTC observation journal');
    this.nextDiscovery=0;this.nextSettlement=0;this.current=null;this.busy=false;
  }
  emit(event){this.log({at:this.now(),observationOnly:true,...event});}
  persist(next,event){this.store.save(next);this.state=next;if(event)this.emit(event);}
  async discover() {
    if(this.now()<this.nextDiscovery)return;this.nextDiscovery=this.now()+60000;
    if(!this.series){const {series}=await this.read('/series/KXBTC15M');
      if(series?.ticker!=='KXBTC15M'||series.frequency!=='fifteen_min'||series.fee_type!=='quadratic'||
        !Number.isFinite(Number(series.fee_multiplier)))throw new Error('Unexpected BTC fee metadata');this.series=series;}
    const {markets}=await this.read('/markets?series_ticker=KXBTC15M&status=open&limit=100');
    this.current=(markets??[]).filter(m=>/^KXBTC15M-[A-Z0-9-]+$/.test(m.ticker)&&
      ['open','active'].includes(m.status)&&Date.parse(m.open_time)<=this.now()&&Date.parse(m.close_time)>this.now()&&
      Date.parse(m.close_time)-Date.parse(m.open_time)===900000)
      .sort((a,b)=>Date.parse(a.close_time)-Date.parse(b.close_time))[0]??null;
    if(this.current&&!this.state.markets[this.current.ticker]) {
      const next=structuredClone(this.state),m=this.current;
      next.markets[m.ticker]={ticker:m.ticker,closeTime:m.close_time,target:null,startedAt:this.now(),
        feeMultiplier:Number(this.series.fee_multiplier),candidate:null,result:null,checks:[],guards:{}};
      this.persist(next,{event:'MARKET',ticker:m.ticker,closeTime:m.close_time});
    }
  }
  async observe() {
    const market=this.current;if(!market)return;
    let seconds=(Date.parse(market.close_time)-this.now())/1000;
    if(seconds<=0){this.current=null;this.nextDiscovery=0;return;}
    if(seconds>=90||this.state.markets[market.ticker].candidate)return;
    const initial=this.state.markets[market.ticker];
    if(!Number.isFinite(initial.target)&&this.now()>=(this.nextTarget??0)) {
      this.nextTarget=this.now()+15000;
      const {market:fresh}=await this.read('/markets/'+market.ticker);
      const target=Number(fresh?.floor_strike);
      if(fresh?.ticker===market.ticker&&Number.isFinite(target)&&target>0){
        const next=structuredClone(this.state);next.markets[market.ticker].target=target;this.persist(next);}
    }
    const started=this.now(),data=await this.read('/markets/'+market.ticker+'/orderbook?depth=1');
    const at=this.now();seconds=(Date.parse(market.close_time)-at)/1000;
    if(at-started>2000||seconds<=0||seconds>=90)return;
    const book=metalBook(data),next=structuredClone(this.state),row=next.markets[market.ticker];
    const estimate=estimateMetalEntry({book,stage:{budget:2500,minPrice:.99},feeMultiplier:row.feeMultiplier});
    const proposed=estimate&&estimate.count-estimate.estimatedCost>1e-9?estimate:null;
    let check={allowed:false,reason:'NO_EXECUTABLE_PRICE_OR_VOLUME'};
    if(proposed)check=evaluateBtcLarge({history:this.feed?.getHistory('BTC'),quote:this.feed?.getQuote('BTC'),
      target:row.target,side:proposed.side,secondsRemaining:seconds,now:at,previous:row.guards[proposed.side],ticker:row.ticker});
    if(proposed&&check.guard?.guardState)row.guards[proposed.side]=check.guard.guardState;
    const sample={at,secondsRemaining:seconds,side:proposed?.side??null,price:proposed?.price??null,
      target:row.target,...check};row.checks=[...row.checks,sample].slice(-120);
    let event={event:'CHECK',ticker:row.ticker,...sample};
    if(check.allowed) {
      row.candidate={...proposed,...sample,fillAssumed:true,feesAreEstimated:true,
        budget:2500,unusedBudget:2500-proposed.estimatedCost,
        potentialNet:proposed.count-proposed.estimatedCost,fullBudgetFilled:proposed.estimatedCost>=2499};
      event={event:'CANDIDATE',ticker:row.ticker,...row.candidate,
        filtersNotEvaluated:['account-risk','available-cash','combined-live-exposure']};
    }
    this.persist(next,event);
  }
  async settleOne() {
    if(this.now()<this.nextSettlement)return;this.nextSettlement=this.now()+60000;
    const pending=Object.values(this.state.markets).filter(r=>!r.result&&Date.parse(r.closeTime)<=this.now());
    if(!pending.length)return;this.cursor=(this.cursor??-1)+1;const row=pending[this.cursor%pending.length];
    const {market}=await this.read('/markets/'+row.ticker);
    if(market?.ticker!==row.ticker||!['finalized','settled'].includes(market.status)||!['yes','no'].includes(market.result))return;
    const next=structuredClone(this.state),r=next.markets[row.ticker],c=r.candidate;
    r.result=market.result;r.settledAt=this.now();r.estimatedCost=c?.estimatedCost??0;
    r.payout=c?.side===r.result?c.count:0;r.net=r.payout-r.estimatedCost;
    const t=next.totals;t.windows++;t.entries+=c?1:0;t.wins+=r.net>0?1:0;t.losses+=r.net<0?1:0;t.net+=r.net;
    const closed=Object.values(next.markets).filter(r=>r.result).sort((a,b)=>b.settledAt-a.settledAt);
    for(const old of closed.slice(512))delete next.markets[old.ticker];
    this.persist(next,{event:'SETTLED_ESTIMATE',ticker:r.ticker,result:r.result,entry:c,
      estimatedCost:r.estimatedCost,hypotheticalPayout:r.payout,hypotheticalNet:r.net,
      partialWindow:r.startedAt>Date.parse(r.closeTime)-90000,
      filtersNotEvaluated:['account-risk','available-cash','combined-live-exposure']});
  }
  async tick(){if(this.busy)return;this.busy=true;try{
    try{await this.discover();await this.observe();}catch(e){this.emit({event:'READ_ERROR',message:e.message});}
    try{await this.settleOne();}catch(e){this.emit({event:'SETTLEMENT_ERROR',message:e.message});}
  }finally{this.busy=false;}}
  start(){this.emit({event:'STARTED',rules:BTC_LARGE_RULES,priceCap:null,liveOrders:false,
    executionModel:'ONE_SNAPSHOT_PER_WINDOW_TOP_LEVEL_VOLUME_NO_FILL_RETRIES'});
    void this.tick();this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref?.();return this;}
  stop(){clearInterval(this.timer);}
}
