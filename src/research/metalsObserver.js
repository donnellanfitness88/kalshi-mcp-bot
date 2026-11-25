import { PullbackHistory, observeWick, updateWickTotals, wickMetrics, wickOutcome } from './btcWickStudy.js';
import { entryCrossingBuffer } from '../engine/silverEntryBuffer.js';
import { repeatedCrossingGuard } from '../engine/repeatedCrossingGuard.js';
import { PILOT_WICK_MARKETS, PILOT_WICK_BUDGET, PILOT_WICK_CUTOFF_SECONDS } from '../engine/lateMarkets.js';
import { NinetyStudy } from './ninetyStudy.js';
import fs from 'node:fs';
import path from 'node:path';
import {MetalsProxy} from './metalsProxy.js';
import {MassiveComparison} from './massiveComparison.js';
import {evaluateShrinkingCushion} from '../engine/shrinkingCushion.js';

// Observation only: this module never imports authenticated clients or order code.
// Keep the existing name/journal to preserve accumulated metals observations.
export const METALS = { GOLD: 'KXGOLD15M', SILVER: 'KXSILVER15M', EURUSD:'KXEURUSD15M', USDJPY:'KXUSDJPY15M' };
const PAPER_MARKETS = { WTI: 'KXWTI15M', COPPER: 'KXCOPPER15M', USDCAD: 'KXUSDCAD15M' };
const PAPER_WICK_BUDGET = 300;
const OBSERVED_MARKETS = {...METALS,...PAPER_MARKETS};
const SERIES_PATTERN = Object.values(OBSERVED_MARKETS).join('|');
const SERIES_ROUTE = new RegExp('^/series/(?:'+SERIES_PATTERN+')$');
const MARKET_ROUTE = new RegExp('^/markets/(?:'+SERIES_PATTERN+')-[A-Z0-9-]+(?:/orderbook[?]depth=1)?$');
export const METALS_STAGES = [
  { id: 'under_180', maxSeconds: 180, minPrice: .90, budget: 2 },
  { id: 'under_150', maxSeconds: 150, minPrice: .93, budget: 5 },
  { id: 'under_120', maxSeconds: 120, minPrice: .95, budget: 25 },
  { id: 'under_60', maxSeconds: 60, minPrice: .97, budget: 50 },
  { id: 'under_45', maxSeconds: 45, minPrice: .98, budget: 100 }
];
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MAX_RESPONSE_AGE_MS = 2000;
const SHRINK_TEST = 'all_four_shrinking_no_fixed_minimum_v1';

// Shared observer/live qualification for the four approved markets.
// No fixed distance/drop floor; live BTC retains its existing thresholds.
export function metalShrinkingCheck({asset,ticker,side,target,proxy,history,
  previous=null,at,secondsRemaining,requireLongRecovery=false,stabilizationSeconds=2,requireStableAlways=false,requireLongAlways=false,paperRecoveryPullback=null,projectedLookbackSeconds}) {
  const blocked=reason=>({allowed:false,reason,guardState:previous});
  if(!Number.isFinite(target)||target<=0||!['yes','no'].includes(side))
    return blocked('INVALID_TARGET_OR_SIDE');
  if(proxy?.status!=='FRESH_PROXY'||!Number.isFinite(proxy.price)||proxy.price<=0||
    !Number.isFinite(proxy.sourceAt)||at-proxy.sourceAt<0||at-proxy.sourceAt>2000)
    return blocked('MISSING_OR_STALE_PROXY');
  if((side==='yes'?1:-1)*(proxy.price-target)<=0)
    return blocked('REFERENCE_NOT_ON_WINNING_SIDE');
  const rows=(history??[]).map(p=>({
    sourceTs:Math.trunc(p.sourceAt),price:p.price
  }));
  const last=rows.at(-1);
  if(!last||last.sourceTs!==Math.trunc(proxy.sourceAt)||last.price!==proxy.price)
    return blocked('SHRINK_HISTORY_UNAVAILABLE');
  return evaluateShrinkingCushion({
    history:rows,asset,ticker,side,target,minimumDistance:0,
    rapidDropMinimum:0,observationOnlyNoMinimum:true,
    secondsRemaining,previous,requireLongRecovery,stabilizationSeconds,requireStableAlways,requireLongAlways,paperRecoveryPullback,projectedLookbackSeconds,now:at
  });
}
const number = x => (typeof x === 'number' || (typeof x === 'string' && x.trim())) ? Number(x) : NaN;
export const metalsStage = seconds => Number.isFinite(seconds) && seconds > 0
  ? METALS_STAGES.findLast(s => seconds < s.maxSeconds) ?? null : null;

export function activeMetalMarket(markets, asset, now) {
  return (Array.isArray(markets) ? markets : []).filter(m =>
    typeof m.ticker === 'string' && m.ticker.startsWith(OBSERVED_MARKETS[asset] + '-') &&
    ['open', 'active'].includes(m.status) && Date.parse(m.open_time) <= now &&
    Date.parse(m.close_time) > now && Date.parse(m.close_time) - Date.parse(m.open_time) === 900000)
    .sort((a,b) => Date.parse(a.close_time) - Date.parse(b.close_time))[0] ?? null;
}

function levels(rows, cents = false) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (!Array.isArray(row) || row.length < 2) return [];
    const price = number(row[0]) / (cents ? 100 : 1), size = number(row[1]);
    return Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0
      ? [{price, size}] : [];
  }).sort((a,b) => b.price-a.price);
}
export function metalBook(data) {
  const fp = data?.orderbook_fp, old = data?.orderbook;
  const yes = levels(fp?.yes_dollars ?? old?.yes_dollars ?? old?.yes, !fp?.yes_dollars && !old?.yes_dollars);
  const no = levels(fp?.no_dollars ?? old?.no_dollars ?? old?.no, !fp?.no_dollars && !old?.no_dollars);
  if (yes.length && no.length && yes[0].price + no[0].price >= 1 - 1e-9) return null;
  const ask = bids => bids.length ? {price: Math.round((1-bids[0].price)*10000)/10000, size:bids[0].size} : null;
  return {yes:ask(no), no:ask(yes), yesBid:yes[0]?.price ?? null, noBid:no[0]?.price ?? null};
}
export function estimateMetalEntry({book, stage, side, feeMultiplier}) {
  if (!stage || !Number.isFinite(feeMultiplier) || feeMultiplier < 0) return null;
  const choices = ['yes','no'].filter(s => !side || s===side).flatMap(s => {
    const q=book?.[s];
    if (!q || !Number.isFinite(q.price) || q.price < stage.minPrice-1e-9 || q.price>=1 ||
        !Number.isFinite(q.size) || q.size<1) return [];
    let count=Math.min(Math.floor(q.size), Math.floor(stage.budget/q.price));
    const fee = n => Math.ceil(0.07 * feeMultiplier * n * q.price * (1-q.price)*100-1e-9)/100;
    while(count>0 && count*q.price+fee(count)>stage.budget+1e-9) count--;
    if (!count || count-count*q.price-fee(count)<=0) return [];
    return [{side:s, price:q.price, displayedSize:q.size, count,
      estimatedFee:fee(count), estimatedCost:count*q.price+fee(count), budget:stage.budget}];
  }).sort((a,b)=>b.price-a.price);
  return choices[0] ?? null;
}

const WTI_RECOVERY_TEST = 'wti_wick_recovery_v1';
const WTI_RECOVERY_PULLBACK = 0.001; // USD per barrel.

function observeWtiRecovery({row,book,proxy,proxyHistory,history,at,started,observerStartedAt}) {
  const close=Date.parse(row.closeTime), secondsRemaining=(close-at)/1000;
  if(secondsRemaining<=PILOT_WICK_CUTOFF_SECONDS || secondsRemaining>=180 || row.feeType!=='quadratic')
    return [];
  const models=row.wtiRecoveryStudy??={
    partialWindow:observerStartedAt>close-180000,
    strict:{guardStates:{},checks:0,blocked:{}},
    bounded:{guardStates:{},checks:0,blocked:{}}
  };
  const side=['yes','no'].find(side=>{
    const ask=book?.[side];
    return ask?.price>=.90 && ask.price<1 && ask.size>=1 &&
      (secondsRemaining<120 || ask.price<=.979);
  });
  if(!side) return [];
  const plan=estimateMetalEntry({book,stage:{minPrice:.90,budget:PILOT_WICK_BUDGET},
    side,feeMultiplier:row.feeMultiplier});
  if(!plan) return [];
  const reference=proxy?.snapshot('WTI',row.target,side);
  const config=PILOT_WICK_MARKETS.WTI;
  const events=[];
  for(const model of ['strict','bounded']) {
    const run=models[model];
    if(run.candidate) continue;
    run.checks++;
    let guard=metalShrinkingCheck({asset:'WTI',ticker:row.ticker,side,target:row.target,
      proxy:reference,history:proxyHistory,at,secondsRemaining,previous:run.guardStates[side],
      requireLongRecovery:true,requireLongAlways:true,stabilizationSeconds:5,
      paperRecoveryPullback:model==='bounded'?WTI_RECOVERY_PULLBACK:null});
    if(guard.guardState) run.guardStates[side]=guard.guardState;
    guard=repeatedCrossingGuard(guard,'WTI',side,row.target,close,at,proxyHistory,config.repeatedCrossingCushion);
    let reason=guard.allowed?null:guard.reason;
    if(!reason && !guard.crossingHistoryComplete) reason='PILOT_WICK_CROSSING_HISTORY_INCOMPLETE';
    if(!reason && !(guard.currentCushion+1e-9>=config.minimumCushion)) reason='PILOT_WICK_CUSHION_TOO_SMALL';
    const requiredHoldMs=guard.targetCrossings>0?15000:5000;
    const wick=reason?null:wickMetrics(history,at,row.target,side==='yes'?1:-1,close,guard.crossingWickMinimum??0);
    if(!reason && !(wick?.heldMs>=requiredHoldMs)) reason='WTI_RECOVERY_WICK_HOLD';
    if(reason) {
      run.blocked[reason]=(run.blocked[reason]??0)+1;
      continue;
    }
    run.candidate={...plan,quotedAt:at,bookRequestMs:at-started,secondsRemaining,
      target:row.target,referencePrice:reference.price,referenceAgeMs:at-reference.sourceAt,
      cushion:guard.currentCushion,cushionChange15:guard.longRecovery.cushionChange15,
      cushionChange60:guard.longRecovery.cushionChange60,targetCrossings:guard.targetCrossings,
      heldMs:wick.heldMs,boundedRecovery:guard.boundedRecovery===true};
    events.push({event:'WTI_RECOVERY_CANDIDATE',testId:WTI_RECOVERY_TEST,asset:'WTI',ticker:row.ticker,
      model,...run.candidate});
  }
  return events;
}

function wtiRecoverySettlement(row) {
  const study=row.wtiRecoveryStudy;
  const models=Object.fromEntries(['strict','bounded'].map(model=>{
    const {candidate,checks,blocked}=study[model];
    const payout=candidate?.side===row.result?candidate.count:0;
    return [model,{checks,blocked,candidate:candidate??null,payout,
      netAfterEstimatedFees:candidate?payout-candidate.estimatedCost:0,
      outcome:candidate?(payout?'win':'loss'):'no_entry'}];
  }));
  return {event:'WTI_RECOVERY_SETTLED',testId:WTI_RECOVERY_TEST,asset:'WTI',ticker:row.ticker,
    result:row.result,partialWindow:study.partialWindow,models};
}

// Restrict the network adapter itself to public GET market/series endpoints.
export async function publicMetalRead(route) {
  const exact = SERIES_ROUTE.test(route) || MARKET_ROUTE.test(route);
  let discovery=false;
  if(route.startsWith('/markets?')) {
    const q=new URLSearchParams(route.slice('/markets?'.length));
    discovery=[...q.keys()].length===3 && [...q.keys()].every(k=>['series_ticker','status','limit'].includes(k)) &&
      Object.values(OBSERVED_MARKETS).includes(q.get('series_ticker')) && q.get('status')==='open' && q.get('limit')==='100';
  }
  if (!exact && !discovery) throw new Error('Observer route not allowed');
  const r = await fetch(BASE+route, {method:'GET', signal:AbortSignal.timeout(8000), redirect:'error'});
  if (!r.ok) throw new Error('Public market read HTTP '+r.status);
  return r.json();
}
export function metalsDirectory() {
  return process.env.METALS_OBSERVER_DIR ?? path.join(process.env.SCALP_STATE_DIR ?? 'data', 'metals-observer');
}
export function fileObserverStore(directory = metalsDirectory()) {
  const file = path.join(directory, 'state.json');
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file,'utf8')); }
      catch(e) { if(e.code==='ENOENT') return null; throw e; }
    },
    save(value) {
      fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)); fs.renameSync(file+'.tmp',file);
    }
  };
}

export class MetalsObserver {
  constructor({read=publicMetalRead, store=fileObserverStore(), now=Date.now, proxy=null,
    log=event=>console.log('[METALS_OBSERVER] '+JSON.stringify(event))}={}) {
    Object.assign(this,{read,store,now,log,proxy});
    this.startedAt=this.now();
    this.state=store.load() ?? {version:1, markets:{}, totals:{}};
    if(this.state.version!==1 || !this.state.markets || !this.state.totals) throw new Error('Invalid metals observer journal');
    this.current={}; this.nextDiscovery={}; this.nextTargetRead={}; this.nextSettlement=0; this.series={}; this.busy=false;
    this.paperWaitingForProxy=new Set();
  }
  emit(event) { this.log({at:this.now(), observationOnly:true, ...event}); }
  persist(next, event) {
    this.store.save(next); this.state=next;
    if(event) this.emit(event);
  }
  async discover(asset) {
    const now=this.now();
    if(now < (this.nextDiscovery[asset] ?? 0)) return;
    this.nextDiscovery[asset]=now+60000;
    if(!this.series[asset]) {
      const {series}=await this.read('/series/'+OBSERVED_MARKETS[asset]);
      if(series?.ticker!==OBSERVED_MARKETS[asset] || series.frequency!=='fifteen_min') throw new Error('Unexpected metals series');
      this.series[asset]=series;
      this.emit({event:'SERIES',asset,feeType:series.fee_type,feeMultiplier:series.fee_multiplier,
        settlementSources:series.settlement_sources});
    }
    const data=await this.read('/markets?'+new URLSearchParams({series_ticker:OBSERVED_MARKETS[asset],status:'open',limit:100}));
    const market=activeMetalMarket(data.markets,asset,this.now());
    this.current[asset]=market;
    if(!market) { this.emit({event:'NO_OPEN_MARKET',asset}); return; }
    if(!this.state.markets[market.ticker]) {
      const next=structuredClone(this.state);
      next.markets[market.ticker]={asset,ticker:market.ticker,closeTime:market.close_time,
        ...(Object.hasOwn(PAPER_MARKETS,asset)?{startedAt:this.now()}:{}),
        target:number(market.floor_strike)||null,rulesPrimary:market.rules_primary,rulesSecondary:market.rules_secondary,
        source:this.series[asset].settlement_sources,feeType:this.series[asset].fee_type,
        feeMultiplier:number(this.series[asset].fee_multiplier),
        observations:[],candidates:[],side:null,result:null};
      this.persist(next,{event:'MARKET',asset,ticker:market.ticker,closeTime:market.close_time});
    }
  }
  async observe(asset) {
    const paperOnly=Object.hasOwn(PAPER_MARKETS,asset);
    const market=this.current[asset];
    if(!market) return;
    const seconds=(Date.parse(market.close_time)-this.now())/1000;
    if(seconds<=0) { this.current[asset]=null; this.nextDiscovery[asset]=0; return; }
    // Paper wick checks require a fresh price. Avoid book requests while that input is missing.
    if(paperOnly) {
      if(this.proxy?.snapshot(asset,null,null)?.status!=='FRESH_PROXY') {
        if(!this.paperWaitingForProxy.has(asset)) {
          this.paperWaitingForProxy.add(asset);
          this.emit({event:'PAPER_BOOK_WAITING_FOR_PROXY',asset,ticker:market.ticker});
        }
        return;
      }
      if(this.paperWaitingForProxy.delete(asset))
        this.emit({event:'PAPER_BOOK_PROXY_READY',asset,ticker:market.ticker});
    }
    // Reuse the same public book read for both studies during staged windows.
    // Some newly opened markets publish their strike after initial discovery.
    // Refresh missing targets without discarding prior observations or candidates.
    if(!Number.isFinite(number(this.state.markets[market.ticker]?.target)) && this.now()>=(this.nextTargetRead[asset]??0)) {
      this.nextTargetRead[asset]=this.now()+15000;
      try {
        const {market:fresh}=await this.read('/markets/'+encodeURIComponent(market.ticker));
        const target=number(fresh?.floor_strike);
        if(fresh?.ticker===market.ticker && Number.isFinite(target) && target>0) {
          const next=structuredClone(this.state);next.markets[market.ticker].target=target;
          this.persist(next,{event:'TARGET_READY',asset,ticker:market.ticker,target});
        }
      } catch {} // Missing metadata cannot stop the independent price-time observer.
    }
    const started=this.now(), data=await this.read('/markets/'+encodeURIComponent(market.ticker)+'/orderbook?depth=1');
    const at=this.now(), stage=metalsStage((Date.parse(market.close_time)-at)/1000);
    if(at-started>MAX_RESPONSE_AGE_MS || at>=Date.parse(market.close_time)) return;
    const book=metalBook(data), currentRow=this.state.markets[market.ticker];
    const proxyHistory=this.proxy?.history?.[asset]??[];
    const history=proxyHistory.map(p=>({sourceTs:Math.trunc(p.sourceAt),price:p.price}));
    this.wickHistories??={};
    const pullbacks=this.wickHistories[asset]??=new PullbackHistory();
    pullbacks.ingest(history,at);
    this.ninetyStudy ??= new NinetyStudy();
    const observation=this.ninetyStudy.sample({asset,row:currentRow,book,proxy:this.proxy,at,started,estimate:estimateMetalEntry});
    if(!stage && !observation) return;
    const next=structuredClone(this.state), row=next.markets[market.ticker];
    if(stage && row.feeType==='quadratic') {
      const close=Date.parse(row.closeTime);
      const secondsRemaining=(close-at)/1000;
      observeWick(row,book,history,at,pullbacks,{
        budget:paperOnly?PAPER_WICK_BUDGET:undefined,
        floor:0,
        // Express the exploratory settlement screen in each market's existing buffer units.
        flipMinimum:guard=>paperOnly?0:guard.crossingMinimum,
        guard:(side,previous)=>{
          const check=metalShrinkingCheck({asset,ticker:row.ticker,side,target:row.target,
            proxy:this.proxy?.snapshot(asset,row.target,side),history:proxyHistory,
            previous,at,secondsRemaining,requireLongRecovery:true,requireLongAlways:true,
            stabilizationSeconds:5});
          return repeatedCrossingGuard(entryCrossingBuffer(check,asset,secondsRemaining,at),
            asset,side,row.target,close,at,proxyHistory);
        }
      });
    }
    if(observation) {
      row.study90=observation;
      this.persist(next,{event:paperOnly?'PAPER90_QUOTE':'FOUR90_QUOTE',asset,ticker:row.ticker,...observation});
    }
    if(!stage) return;
    const wtiRecoveryEvents=asset==='WTI'
      ?observeWtiRecovery({row,book,proxy:this.proxy,proxyHistory,history,at,started,observerStartedAt:this.startedAt})
      :[];
    const candidate=!row.candidates.some(c=>c.stageId===stage.id) && row.feeType==='quadratic'
      ? estimateMetalEntry({book,stage,side:row.side,feeMultiplier:row.feeMultiplier}) : null;
    const quoteSide=book?.yes && (!book.no || book.yes.price>=book.no.price)?'yes':book?.no?'no':null;
    const proxySide=paperOnly?quoteSide:candidate?.side??row.side;
    const proxy=this.proxy?.snapshot(asset,row.target,proxySide)??null;
    const sample={at,secondsRemaining:(Date.parse(market.close_time)-at)/1000,stageId:stage.id,book,
      referencePrice:null,distance:null,proximity:'NOT_EVALUATED',shrinkingGuard:'NOT_EVALUATED',proxySide,proxy};
    // Independent scenario; retain previous fixed-cushion history.
    let shrinkEvent=null;
    const test=row.shrinkTest??={
      id:SHRINK_TEST,startedAt:at,
      partialWindow:this.startedAt>Date.parse(row.closeTime)-180000,
      side:null,candidates:[],blockedChecks:0,guardStates:{}
    };
    const proposed=!test.candidates.some(c=>c.stageId===stage.id)&&
      row.feeType==='quadratic'
      ?estimateMetalEntry({
        book,stage,side:test.side,feeMultiplier:row.feeMultiplier
      }):null;
    if(proposed) {
      const reference=this.proxy?.snapshot(asset,row.target,proposed.side)??null;
      const check=metalShrinkingCheck({
        asset,ticker:row.ticker,side:proposed.side,target:row.target,
        proxy:reference,history:this.proxy?.history?.[asset],
        previous:test.guardStates[proposed.side],
        at,secondsRemaining:sample.secondsRemaining
      });
      if(check.guardState)
        test.guardStates[proposed.side]=check.guardState;
      if(check.allowed) {
        test.side=proposed.side;
        test.candidates.push({
          ...sample,...proposed,proxySide:proposed.side,proxy:reference,
          shrinkingGuard:check,proximity:'WINNING_SIDE_ONLY',
          qualification:'PRICE_TIME_LIQUIDITY_PROXY_SHRINKING',
          fillAssumed:true,feesAreEstimated:true
        });
      } else test.blockedChecks++;
      shrinkEvent={
        event:check.allowed?'SHRINK_CANDIDATE':'SHRINK_BLOCKED',
        testId:SHRINK_TEST,asset,ticker:row.ticker,stageId:stage.id,
        ...proposed,target:row.target,proxy:reference,shrinkingGuard:check
      };
    }
    row.observations=[...row.observations,sample].slice(-120);
    // One theoretical snapshot per tier, not a claim of fill or a full strategy replay.
    if(candidate) {
      row.side=candidate.side;
      row.candidates.push({...sample,...candidate,stageId:stage.id,
        qualification:'PRICE_TIME_LIQUIDITY_ONLY',fillAssumed:true,feesAreEstimated:true});
    }
    this.persist(next,candidate?{event:'CANDIDATE',asset,ticker:market.ticker,stageId:stage.id,
      ...candidate,target:row.target,proxySide,proxy,qualification:'PRICE_TIME_LIQUIDITY_ONLY',proximity:'NOT_EVALUATED',shrinkingGuard:'NOT_EVALUATED'}:null);
    for(const event of wtiRecoveryEvents) this.emit(event);
    if(shrinkEvent)this.emit(shrinkEvent);
    if(paperOnly) {
      const range=proxy?.movement?.[60]?.range;
      const cushionTo60sRange=range>0 && Number.isFinite(proxy.estimatedCushion)
        ? proxy.estimatedCushion/range : null;
      this.emit({event:'PAPER_MARKET_QUOTE',asset,ticker:row.ticker,target:row.target,
        secondsRemaining:sample.secondsRemaining,book,proxySide,proxy,cushionTo60sRange});
    }
    if(proxy&&!paperOnly)this.emit({event:'PROXY_OBSERVATION',asset,ticker:market.ticker,target:row.target,
      secondsRemaining:sample.secondsRemaining,proxySide,proxy});
  }
  async settleOne() {
    if(this.now()<this.nextSettlement) return;
    this.nextSettlement=this.now()+60000;
    const pending=Object.values(this.state.markets).filter(r=>!r.result && Date.parse(r.closeTime)<=this.now());
    if(!pending.length) return;
    this.settlementIndex=(this.settlementIndex??-1)+1;
    const row=pending[this.settlementIndex%pending.length];
    const {market}=await this.read('/markets/'+encodeURIComponent(row.ticker));
    if(market?.ticker!==row.ticker || !['settled','finalized'].includes(market.status) || !['yes','no'].includes(market.result)) return;
    const next=structuredClone(this.state), r=next.markets[row.ticker];
    r.result=market.result; r.settledAt=this.now(); r.expirationValue=market.expiration_value;
    r.estimatedCost=r.candidates.reduce((n,c)=>n+c.estimatedCost,0);
    r.hypotheticalPayout=r.candidates.reduce((n,c)=>n+(c.side===r.result?c.count:0),0);
    r.hypotheticalNet=r.hypotheticalPayout-r.estimatedCost;
    const totals=next.totals[r.asset]??{sampledMarkets:0,candidateMarkets:0,wins:0,losses:0,estimatedCost:0,hypotheticalNet:0};
    totals.sampledMarkets++; totals.candidateMarkets+=r.candidates.length?1:0;
    totals.wins+=r.hypotheticalNet>0?1:0; totals.losses+=r.hypotheticalNet<0?1:0;
    totals.estimatedCost+=r.estimatedCost; totals.hypotheticalNet+=r.hypotheticalNet; next.totals[r.asset]=totals;
    let cushionSettlement=null;
    if(r.cushionTest) {
      const test=r.cushionTest;
      test.estimatedCost=test.candidates.reduce((n,c)=>n+c.estimatedCost,0);
      test.hypotheticalPayout=test.candidates.reduce((n,c)=>n+(c.side===r.result?c.count:0),0);
      test.hypotheticalNet=test.hypotheticalPayout-test.estimatedCost;
      next.cushionTotals??={};
      const totals=next.cushionTotals[r.asset]??={sampledMarkets:0,candidateMarkets:0,wins:0,losses:0,estimatedCost:0,hypotheticalNet:0};
      totals.sampledMarkets++;totals.candidateMarkets+=test.candidates.length?1:0;
      totals.wins+=test.hypotheticalNet>0?1:0;totals.losses+=test.hypotheticalNet<0?1:0;
      totals.estimatedCost+=test.estimatedCost;totals.hypotheticalNet+=test.hypotheticalNet;
      cushionSettlement={event:'CUSHION_SETTLED_ESTIMATE',testId:test.id,asset:r.asset,ticker:r.ticker,
        result:r.result,startedAt:test.startedAt,candidates:test.candidates.length,blockedChecks:test.blockedChecks,
        estimatedCost:test.estimatedCost,hypotheticalPayout:test.hypotheticalPayout,hypotheticalNet:test.hypotheticalNet,
        baselineNet:r.hypotheticalNet,partialWindow:test.partialWindow,
        filtersNotEvaluated:['shrinking-cushion','account-risk','available-cash'],referenceType:'SPOT_PROXY_NOT_SETTLEMENT'};
    }
    let shrinkSettlement=null;
    if(r.shrinkTest) {
      const test=r.shrinkTest;
      test.estimatedCost=test.candidates.reduce((n,c)=>n+c.estimatedCost,0);
      test.hypotheticalPayout=test.candidates.reduce(
        (n,c)=>n+(c.side===r.result?c.count:0),0);
      test.hypotheticalNet=test.hypotheticalPayout-test.estimatedCost;
      next.shrinkTotals??={};
      const totals=next.shrinkTotals[r.asset]??={
        sampledMarkets:0,candidateMarkets:0,wins:0,losses:0,
        estimatedCost:0,hypotheticalNet:0
      };
      totals.sampledMarkets++;
      totals.candidateMarkets+=test.candidates.length?1:0;
      totals.wins+=test.hypotheticalNet>1e-9?1:0;
      totals.losses+=test.hypotheticalNet< -1e-9?1:0;
      totals.estimatedCost+=test.estimatedCost;
      totals.hypotheticalNet+=test.hypotheticalNet;
      shrinkSettlement={
        event:'SHRINK_SETTLED_ESTIMATE',testId:test.id,
        asset:r.asset,ticker:r.ticker,result:r.result,
        startedAt:test.startedAt,candidates:test.candidates.length,
        blockedChecks:test.blockedChecks,estimatedCost:test.estimatedCost,
        hypotheticalPayout:test.hypotheticalPayout,
        hypotheticalNet:test.hypotheticalNet,baselineNet:r.hypotheticalNet,
        partialWindow:test.partialWindow,
        filtersNotEvaluated:['account-risk','available-cash'],
        referenceType:'SPOT_PROXY_NOT_SETTLEMENT'
      };
    }
    const paperOnly=Object.hasOwn(PAPER_MARKETS,r.asset);
    let wickResult;
    if(r.wickStudy) {
      const totalsKey=paperOnly?'paperWickTotals':'fourWickTotals';
      next[totalsKey]??={};
      const totals=next[totalsKey][r.asset]??={};
      updateWickTotals(totals,r);
      wickResult={event:paperOnly?'PAPER_WICK_SETTLED':'FOUR_WICK_SETTLED',asset:r.asset,ticker:r.ticker,result:r.result,
        reference:paperOnly?'PYTH_REFERENCE_FEED':'PYTH_SPOT_PROXY',
        ...(paperOnly?{budget:PAPER_WICK_BUDGET}:{}),settlementModel:'equal-weight last sample per completed second, research proxy',
        ...wickOutcome(r),totals};
    }
    const closed=Object.values(next.markets).filter(m=>m.result).sort((a,b)=>b.settledAt-a.settledAt);
    for(const old of closed.slice(512)) delete next.markets[old.ticker];
    this.persist(next,{event:'SETTLED_ESTIMATE',asset:r.asset,ticker:r.ticker,result:r.result,
      candidates:r.candidates.length,estimatedCost:r.estimatedCost,hypotheticalPayout:r.hypotheticalPayout,
      hypotheticalNet:r.hypotheticalNet,filtersNotEvaluated:['proximity','shrinking-cushion','account-risk','available-cash']});
    if(r.wtiRecoveryStudy)this.emit(wtiRecoverySettlement(r));
    if(wickResult)this.emit(wickResult);
    const quote=r.study90;
    const net=quote?.plan && !quote.ambiguous
      ? (quote.side===r.result?quote.plan.count:0)-quote.plan.estimatedCost : null;
    this.emit({event:paperOnly?'PAPER90_SETTLED':'FOUR90_SETTLED',asset:r.asset,ticker:r.ticker,result:r.result,
      observedAt:quote?.at??null,modelNet:net,trendNet:net===null||quote.signedFourHourReturn===null
        ? null : quote.signedFourHourReturn>0?net:0});
    if(cushionSettlement)this.emit(cushionSettlement);
    if(shrinkSettlement)this.emit(shrinkSettlement);
  }
  async tick() {
    if(this.busy) return;
    this.busy=true;
    try {
      for(const asset of Object.keys(METALS)) {
        try { await this.discover(asset); await this.observe(asset); }
        catch(e) { this.emit({event:'READ_ERROR',asset,message:e.message}); }
      }
      try { await this.settleOne(); } catch(e) { this.emit({event:'SETTLEMENT_ERROR',message:e.message}); }
    } finally { this.busy=false; }
  }
  async tickPaper() {
    if(this.paperBusy) return;
    this.paperBusy=true;
    try {
      await Promise.all(Object.keys(PAPER_MARKETS).map(async asset=>{
        try { await this.discover(asset); await this.observe(asset); }
        catch(e) { this.emit({event:'READ_ERROR',asset,message:e.message}); }
      }));
    } finally { this.paperBusy=false; }
  }
  start() {
    this.emit({event:'STARTED',mode:'PRICE_TIME_OBSERVATION',stages:METALS_STAGES,
      assets:METALS,paperAssets:PAPER_MARKETS,paperWickBudget:PAPER_WICK_BUDGET,
      paperBooksRequireFreshProxy:true,wtiRecoveryTest:{id:WTI_RECOVERY_TEST,
        budget:PILOT_WICK_BUDGET,maxPullback:WTI_RECOVERY_PULLBACK,models:['strict','bounded']},
      shrinkingTest:{id:SHRINK_TEST,assets:Object.keys(METALS),
      fixedMinimum:null,rapidDropFraction:.30,recoverySeconds:2},referenceFeed:'NOT_CONNECTED',proxyFeed:this.proxy?'SPOT_PROXY_OPTIONAL':'NOT_CONNECTED',liveOrders:false});
    void this.tick(); this.timer=setInterval(()=>void this.tick(),5000); this.timer.unref?.();
    void this.tickPaper();
    this.paperTimer=setInterval(()=>void this.tickPaper(),5000); this.paperTimer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); clearInterval(this.paperTimer); this.massiveComparison?.stop(); this.proxy?.stop(); }
}

export function startMetalsObserver() {
  const observer=new MetalsObserver();
  observer.proxy=new MetalsProxy({log:event=>observer.emit(event)}).start(process.env.PYTH_PRO_API_KEY);
  if (process.env.MASSIVE_COMPARISON_ENABLED === 'true') {
    observer.massiveComparison=new MassiveComparison(observer).start(process.env.MASSIVE_API_KEY);
  }
  return observer.start();
}
