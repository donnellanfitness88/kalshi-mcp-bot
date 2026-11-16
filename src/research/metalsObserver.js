import fs from 'node:fs';
import path from 'node:path';
import {MetalsProxy} from './metalsProxy.js';

// Observation only: this module never imports authenticated clients or order code.
// Keep the existing name/journal to preserve accumulated metals observations.
export const METALS = { GOLD: 'KXGOLD15M', SILVER: 'KXSILVER15M', EURUSD:'KXEURUSD15M', USDJPY:'KXUSDJPY15M' };
export const METALS_STAGES = [
  { id: 'under_180', maxSeconds: 180, minPrice: .90, budget: 2 },
  { id: 'under_150', maxSeconds: 150, minPrice: .93, budget: 5 },
  { id: 'under_120', maxSeconds: 120, minPrice: .95, budget: 25 },
  { id: 'under_60', maxSeconds: 60, minPrice: .97, budget: 50 },
  { id: 'under_45', maxSeconds: 45, minPrice: .98, budget: 100 }
];
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MAX_RESPONSE_AGE_MS = 2000;
const number = x => (typeof x === 'number' || (typeof x === 'string' && x.trim())) ? Number(x) : NaN;
export const metalsStage = seconds => Number.isFinite(seconds) && seconds > 0
  ? METALS_STAGES.findLast(s => seconds < s.maxSeconds) ?? null : null;

export function activeMetalMarket(markets, asset, now) {
  return (Array.isArray(markets) ? markets : []).filter(m =>
    typeof m.ticker === 'string' && m.ticker.startsWith(METALS[asset] + '-') &&
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

// Restrict the network adapter itself to public GET market/series endpoints.
export async function publicMetalRead(route) {
  const exact = /^\/series\/KX(?:GOLD|SILVER|EURUSD|USDJPY)15M$/.test(route) ||
    /^\/markets\/KX(?:GOLD|SILVER|EURUSD|USDJPY)15M-[A-Z0-9-]+(?:\/orderbook\?depth=1)?$/.test(route);
  let discovery=false;
  if(route.startsWith('/markets?')) {
    const q=new URLSearchParams(route.slice('/markets?'.length));
    discovery=[...q.keys()].length===3 && [...q.keys()].every(k=>['series_ticker','status','limit'].includes(k)) &&
      Object.values(METALS).includes(q.get('series_ticker')) && q.get('status')==='open' && q.get('limit')==='100';
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
    this.state=store.load() ?? {version:1, markets:{}, totals:{}};
    if(this.state.version!==1 || !this.state.markets || !this.state.totals) throw new Error('Invalid metals observer journal');
    this.current={}; this.nextDiscovery={}; this.nextTargetRead={}; this.nextSettlement=0; this.series={}; this.busy=false;
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
      const {series}=await this.read('/series/'+METALS[asset]);
      if(series?.ticker!==METALS[asset] || series.frequency!=='fifteen_min') throw new Error('Unexpected metals series');
      this.series[asset]=series;
      this.emit({event:'SERIES',asset,feeType:series.fee_type,feeMultiplier:series.fee_multiplier,
        settlementSources:series.settlement_sources});
    }
    const data=await this.read('/markets?'+new URLSearchParams({series_ticker:METALS[asset],status:'open',limit:100}));
    const market=activeMetalMarket(data.markets,asset,this.now());
    this.current[asset]=market;
    if(!market) { this.emit({event:'NO_OPEN_MARKET',asset}); return; }
    if(!this.state.markets[market.ticker]) {
      const next=structuredClone(this.state);
      next.markets[market.ticker]={asset,ticker:market.ticker,closeTime:market.close_time,
        target:number(market.floor_strike)||null,rulesPrimary:market.rules_primary,rulesSecondary:market.rules_secondary,
        source:this.series[asset].settlement_sources,feeType:this.series[asset].fee_type,
        feeMultiplier:number(this.series[asset].fee_multiplier),
        observations:[],candidates:[],side:null,result:null};
      this.persist(next,{event:'MARKET',asset,ticker:market.ticker,closeTime:market.close_time});
    }
  }
  async observe(asset) {
    const market=this.current[asset];
    if(!market) return;
    const seconds=(Date.parse(market.close_time)-this.now())/1000;
    if(seconds<=0) { this.current[asset]=null; this.nextDiscovery[asset]=0; return; }
    if(!metalsStage(seconds)) return;
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
    if(at-started>MAX_RESPONSE_AGE_MS || !stage) return;
    const book=metalBook(data), next=structuredClone(this.state), row=next.markets[market.ticker];
    const candidate=!row.candidates.some(c=>c.stageId===stage.id) && row.feeType==='quadratic'
      ? estimateMetalEntry({book,stage,side:row.side,feeMultiplier:row.feeMultiplier}) : null;
    const proxySide=candidate?.side??row.side;
    const proxy=this.proxy?.snapshot(asset,row.target,proxySide)??null;
    const sample={at,secondsRemaining:(Date.parse(market.close_time)-at)/1000,stageId:stage.id,book,
      referencePrice:null,distance:null,proximity:'NOT_EVALUATED',shrinkingGuard:'NOT_EVALUATED',proxySide,proxy};
    row.observations=[...row.observations,sample].slice(-120);
    // One theoretical snapshot per tier, not a claim of fill or a full strategy replay.
    if(candidate) {
      row.side=candidate.side;
      row.candidates.push({...sample,...candidate,stageId:stage.id,
        qualification:'PRICE_TIME_LIQUIDITY_ONLY',fillAssumed:true,feesAreEstimated:true});
    }
    this.persist(next,candidate?{event:'CANDIDATE',asset,ticker:market.ticker,stageId:stage.id,
      ...candidate,target:row.target,proxySide,proxy,qualification:'PRICE_TIME_LIQUIDITY_ONLY',proximity:'NOT_EVALUATED',shrinkingGuard:'NOT_EVALUATED'}:null);
    if(proxy)this.emit({event:'PROXY_OBSERVATION',asset,ticker:market.ticker,target:row.target,
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
    const closed=Object.values(next.markets).filter(m=>m.result).sort((a,b)=>b.settledAt-a.settledAt);
    for(const old of closed.slice(512)) delete next.markets[old.ticker];
    this.persist(next,{event:'SETTLED_ESTIMATE',asset:r.asset,ticker:r.ticker,result:r.result,
      candidates:r.candidates.length,estimatedCost:r.estimatedCost,hypotheticalPayout:r.hypotheticalPayout,
      hypotheticalNet:r.hypotheticalNet,filtersNotEvaluated:['proximity','shrinking-cushion','account-risk','available-cash']});
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
  start() {
    this.emit({event:'STARTED',mode:'PRICE_TIME_OBSERVATION',stages:METALS_STAGES,
      assets:METALS,referenceFeed:'NOT_CONNECTED',proxyFeed:this.proxy?'SPOT_PROXY_OPTIONAL':'NOT_CONNECTED',liveOrders:false});
    void this.tick(); this.timer=setInterval(()=>void this.tick(),5000); this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); this.proxy?.stop(); }
}

export function startMetalsObserver() {
  const observer=new MetalsObserver();
  observer.proxy=new MetalsProxy({log:event=>observer.emit(event)}).start(process.env.PYTH_PRO_API_KEY);
  return observer.start();
}
