import { advanceBtcRangeScalp, advanceBtcStructureScalp, btcRangeScalpNeedsBook,
  btcRangeScalpOutcome, BTC_RANGE_SCALP_RULES, BTC_STRUCTURE_RULES, sampleBtcRangeScalp } from './btcRangeScalp.js';
import { wickRejectionSignal, wickScalpNeedsBook, observeWickRejectionScalp, wickRejectionScalpOutcomes } from './btcChartReversal.js';
import { FiveMinuteBars, chartReversal, captureChartEntry, chartOutcome } from './btcChartReversal.js';
import { observeSettlementDefense, observePaperSpike, experimentOutcome } from './btcWickExperiments.js';
import { PullbackHistory, observeWick, wickOutcome, updateWickTotals } from './btcWickStudy.js';
import fs from 'node:fs';
import path from 'node:path';
import {metalBook,estimateMetalEntry} from './metalsObserver.js';
import {evaluateShrinkingCushion} from '../engine/shrinkingCushion.js';

// Research only. No authenticated client, order submission, or trading-state mutation.
export const BTC_LARGE_RULES={budget:2500,maxSeconds:90,minPrice:.99,
  minimumCushion:50,momentumSeconds:2,rangeSeconds:60,rangeMultiple:1.5,
  maxReferenceAgeMs:2000,maxBookAgeMs:2000};
export const BTC_FAILED_RETEST_RULES = Object.freeze({
  breakBelowTarget: 5, nearTarget: 10, minBounce: 10, turnDown: 5, breakBelowLow: 5,
  reclaimTarget: 3, maxReferenceGapMs: 2000, maxQuoteDelayMs: 7000, paperBudget: 10,
});

export function advanceBtcFailedRetest(tracker, points, target, open, close, now, side = 'no') {
  const rules = BTC_FAILED_RETEST_RULES;
  const events = [];
  // Mirror bullish prices so both directions use the same thresholds.
  const direction = side === 'yes' ? -1 : 1;
  const level = direction * target;
  const extrema = () => side === 'yes'
    ? { priorHigh: -tracker.low, pullbackLow: -tracker.high }
    : { priorLow: tracker.low, bounceHigh: tracker.high };
  for (const { sourceTs, price: reference } of points) {
    if (tracker.done) break;
    if (!Number.isFinite(reference) || reference <= 0 || !Number.isSafeInteger(sourceTs) ||
        sourceTs < open || sourceTs >= close || sourceTs > now || sourceTs <= tracker.lastAt) continue;
    const price = direction * reference;
    const gap = tracker.lastAt && sourceTs - tracker.lastAt > rules.maxReferenceGapMs;
    tracker.lastAt = sourceTs;
    if (gap || price >= level + rules.reclaimTarget) {
      if (tracker.early) {
        tracker.done = true;
        events.push({ phase: 'invalidated', signalAt: sourceTs, reference,
          reason: gap ? 'REFERENCE_GAP' : side === 'yes' ? 'TARGET_LOST' : 'TARGET_RECLAIMED' });
        break;
      }
      tracker.seenTarget = false;
      tracker.low = null;
      tracker.high = null;
    }
    if (price >= level) tracker.seenTarget = true;
    if (!tracker.seenTarget) continue;
    if (tracker.early) {
      if (price < tracker.low - rules.breakBelowLow) {
        tracker.done = true;
        events.push({ phase: 'confirmed', signalAt: sourceTs, reference,
          ...extrema() });
      }
      continue;
    }
    if (tracker.high == null && (tracker.low == null || price < tracker.low)) {
      if (price <= level - rules.breakBelowTarget) tracker.low = price;
      continue;
    }
    if (price >= level - rules.nearTarget && price >= tracker.low + rules.minBounce) {
      tracker.high = Math.max(tracker.high ?? price, price);
    }
    if (tracker.high == null || price > tracker.high - rules.turnDown) continue;
    tracker.early = true;
    events.push({ phase: 'turn', signalAt: sourceTs, reference,
      ...extrema() });
    if (price < tracker.low - rules.breakBelowLow) {
      tracker.done = true;
      events.push({ ...events.at(-1), phase: 'confirmed' });
    }
  }
  return events;
}

const BASE='https://api.elections.kalshi.com/trade-api/v2';
export async function publicBtcObservationRead(route) {
  if(!/^\/markets\/trades\?ticker=KXBTC15M-[A-Z0-9-]+&limit=100$/.test(route)&&route!=='/series/KXBTC15M'&&route!=='/markets?series_ticker=KXBTC15M&status=open&limit=100'&&
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
    onWickSignal, onBearishRetest, log=e=>console.log('[BTC_LARGE_OBSERVER] '+JSON.stringify(e))}={}) {
    Object.assign(this,{feed,read,store,now,log,onWickSignal,onBearishRetest});
    this.state=store.load()??{version:1,markets:{},totals:{windows:0,entries:0,wins:0,losses:0,net:0}};
    if(this.state.version!==1||!this.state.markets||!this.state.totals)throw new Error('Invalid BTC observation journal');
    this.pullbacks=new PullbackHistory();
    this.chartBars=new FiveMinuteBars(this.state.chartCandles);
    this.nextDiscovery=0;this.nextSettlement=0;this.current=null;this.busy=false;
  }
  emit(event){this.log({at:this.now(),observationOnly:true,...event});}
  persist(next,event){this.store.save(next);this.state=next;if(event)this.emit(event);}
  async discover() {
    if(this.now()<this.nextDiscovery && Date.parse(this.current?.close_time)>this.now())return;
    if(this.now()<this.nextDiscovery && !this.current)return;this.nextDiscovery=this.now()+(this.current ? 60000 : 5000);
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
    const recent=this.feed?.getHistory?.('BTC')??[];
    this.pullbacks.ingest(recent,this.now());
    const bars=this.chartBars.ingest(recent,this.now());
    const latestBar=bars.at(-1);
    if (latestBar && latestBar.end!==this.state.chartCandles?.at(-1)?.end) {
      const savedBars=structuredClone(bars);
      let consecutiveComplete=0;
      for (let i=savedBars.length-1; i>=0; i--) {
        const bar=savedBars[i], following=savedBars[i+1];
        if (!bar.complete || (following && bar.end!==following.start)) break;
        consecutiveComplete++;
      }
      this.persist({...this.state,chartCandles:savedBars},
        {event:'CHART_CANDLE_SAVED',candleEnd:latestBar.end,
          complete:latestBar.complete,consecutiveComplete,requiredComplete:11});
    }
    const chart=chartReversal(bars);
    const wickScalp=wickRejectionSignal(bars);
    const market=this.current;if(!market)return;
    let seconds=(Date.parse(market.close_time)-this.now())/1000;
    if(seconds<=0){this.current=null;this.nextDiscovery=0;return;}
    const activeChart=chart && this.now()-chart.confirmedAt<=30000 &&
      chart.confirmedAt>=Date.parse(market.open_time);
    const chartRow=this.state.markets[market.ticker];
    if (activeChart && !chartRow.chartReversal) {
      const next=structuredClone(this.state);
      next.markets[market.ticker].chartReversal=chart;
      this.persist(next,{event:'CHART_REVERSAL',ticker:market.ticker,...chart});
    }
    const now=this.now();
    if (wickScalp && wickScalp.confirmedAt > Date.parse(market.open_time) &&
        now-wickScalp.confirmedAt <= 30000 && seconds > 60 &&
        !this.state.markets[market.ticker].wickRejectionScalps?.[wickScalp.confirmedAt]) {
      const next=structuredClone(this.state);
      const scalps=next.markets[market.ticker].wickRejectionScalps ??= {};
      scalps[wickScalp.confirmedAt]=wickScalp;
      this.persist(next,{event:'WICK_REJECTION_SCALP_SIGNAL',ticker:market.ticker,...wickScalp});
      this.onWickSignal?.({
        ...wickScalp, ticker: market.ticker, feeMultiplier: Number(this.series.fee_multiplier)
      });
    }
    const scalpNeedsQuote=Object.values(this.state.markets[market.ticker].wickRejectionScalps ?? {})
      .some(scalp=>wickScalpNeedsBook(scalp,now));
    const savedChart=this.state.markets[market.ticker].chartReversal;
    const chartNeedsQuote=savedChart && !savedChart.entry && this.now()-savedChart.confirmedAt<=30000;
    if(seconds>=180 && !chartNeedsQuote && !scalpNeedsQuote)return;
    const initial=this.state.markets[market.ticker];
    if(!Number.isFinite(initial.target)&&this.now()>=(this.nextTarget??0)) {
      this.nextTarget=this.now()+15000;
      const {market:fresh}=await this.read('/markets/'+market.ticker);
      const target=Number(fresh?.floor_strike);
      if(fresh?.ticker===market.ticker&&Number.isFinite(target)&&target>0){
        const next=structuredClone(this.state);next.markets[market.ticker].target=target;this.persist(next);}
    }
    const started=this.now();
    const tradeRequest = seconds>=180 || initial.spike?.entry ? Promise.resolve(null) :
      this.read('/markets/trades?ticker='+market.ticker+'&limit=100')
        .catch(error => { this.emit({event:'SPIKE_TRADE_READ_ERROR',message:error.message}); return null; });
    const [data, trades] = await Promise.all([
      this.read('/markets/'+market.ticker+'/orderbook?depth=1'), tradeRequest
    ]);
    const at=this.now();seconds=(Date.parse(market.close_time)-at)/1000;
    if(at-started>2000||seconds<=0)return;
    const book=metalBook(data),next=structuredClone(this.state),row=next.markets[market.ticker];
    const bidSize = side => {
      const levels = data.orderbook_fp?.[side+'_dollars'] ?? data.orderbook?.[side+'_dollars'];
      const bid = book[side+'Bid'];
      return (levels ?? []).find(([price]) => Math.abs(Number(price)-bid)<1e-9)?.[1];
    };
    for (const scalp of Object.values(row.wickRejectionScalps ?? {})) {
      if (wickScalpNeedsBook(scalp,at)) observeWickRejectionScalp(scalp,book,bidSize,at,started,row.feeMultiplier);
    }
    const chartEntered=captureChartEntry(row,book,at,started);
    if (seconds>=180) {
      if (chartEntered) this.persist(next,{event:'CHART_PAPER_ENTRY',ticker:row.ticker,...row.chartReversal.entry});
      else if (scalpNeedsQuote) this.persist(next);
      return;
    }
    if (chartEntered) this.persist(next,{event:'CHART_PAPER_ENTRY',ticker:row.ticker,...row.chartReversal.entry});
    const history = this.feed?.getHistory?.('BTC') ?? [];
    observeWick(row,book,history,at,this.pullbacks);
    if (seconds <= 45 && !row.defense) {
      row.defenseStudy ??= {ticker:row.ticker,closeTime:row.closeTime,target:row.target,
        feeMultiplier:row.feeMultiplier};
      observeWick(row.defenseStudy,book,history,at,this.pullbacks);
      observeSettlementDefense(row,history);
    }
    if (book && !row.spike?.exit) {
      observePaperSpike(row,{...book,yesBidSize:Number(bidSize('yes')??0),
        noBidSize:Number(bidSize('no')??0)},history,trades?.trades??[],at);
    }
    if (row.chartReversal && row.spike?.signal?.side===row.chartReversal.side &&
        row.spike.signal.at>=row.chartReversal.confirmedAt) {
      row.chartReversal.spikeConfirmationAt ??= row.spike.signal.at;
    }
    if(seconds>=90||row.candidate){this.persist(next);return;}
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
  async observeFailedRetest() {
    const market = this.current;
    if (!market) return;
    const ticker = market.ticker, close = Date.parse(market.close_time);
    const now = this.now();
    const row = this.state.markets[ticker];
    if (!row || now >= close) return;
    const studies = { no: 'failedRetest', yes: 'failedPullback' };
    const activeSides = ['no', 'yes'].filter(side => {
      const study = row[studies[side]];
      return !study?.confirmed && !study?.invalidated;
    });
    if (!activeSides.length) return;
    if (this.failedRetestTicker !== ticker) {
      this.failedRetestTicker = ticker;
      this.failedRetestTrackers = {};
      for (const side of activeSides) {
        const turn = row[studies[side]]?.turn;
        this.failedRetestTrackers[side] = turn
          ? { early: true, seenTarget: true, lastAt: turn.signalAt,
              low: side === 'yes' ? -turn.priorHigh : turn.priorLow,
              high: side === 'yes' ? -turn.pullbackLow : turn.bounceHigh }
          : { lastAt: 0 };
      }
      this.failedRetestTarget = null;
      this.nextFailedRetestTarget = 0;
    }
    if (!this.failedRetestTarget && now >= this.nextFailedRetestTarget) {
      this.nextFailedRetestTarget = now + 15000;
      const { market: details } = await this.read('/markets/' + ticker);
      const target = Number(details?.floor_strike);
      if (details?.ticker === ticker && details.strike_type === 'greater_or_equal' &&
          Date.parse(details.close_time) === close && Number.isFinite(target) && target > 0) {
        this.failedRetestTarget = target;
      }
    }
    if (!this.failedRetestTarget) return;
    const at = this.now();
    const target = this.failedRetestTarget;
    const trackers = structuredClone(this.failedRetestTrackers);
    const history = this.feed?.getHistory?.('BTC') ?? [];
    const open = Math.max(Date.parse(market.open_time), row.startedAt);
    const events = activeSides.flatMap(side =>
      advanceBtcFailedRetest(trackers[side], history, target, open, close, at, side)
        .map(event => ({ ...event, side })));
    events.sort((a, b) => a.signalAt - b.signalAt);
    if (!events.length) {
      this.failedRetestTrackers = trackers;
      return;
    }
    const rules = BTC_FAILED_RETEST_RULES;
    let book, quoteAt;
    if (events.some(event => event.phase !== 'invalidated' && at - event.signalAt <= rules.maxQuoteDelayMs)) {
      try {
        const data = await this.read('/markets/' + ticker + '/orderbook?depth=1');
        const receivedAt = this.now();
        if (receivedAt - at <= 2000 && receivedAt < close) {
          book = metalBook(data);
          quoteAt = receivedAt;
        }
      } catch (error) {
        this.emit({ event: 'FAILED_RETEST_QUOTE_ERROR', ticker, message: error.message });
      }
    }
    const next = structuredClone(this.state);
    const samples = events.map(event => {
      const quote = event.phase !== 'invalidated' && quoteAt != null &&
          quoteAt - event.signalAt <= rules.maxQuoteDelayMs
        ? book?.[event.side] : null;
      const entry = quote ? estimateMetalEntry({ book: { [event.side]: quote }, side: event.side,
        stage: { budget: rules.paperBudget, minPrice: .001 }, feeMultiplier: row.feeMultiplier }) : null;
      const sample = { ...event, target, quoteAt: quote ? quoteAt : null,
        quoteDelayMs: quote ? quoteAt - event.signalAt : null,
        [event.side === 'yes' ? 'upAsk' : 'downAsk']: quote?.price ?? null,
        displayedSize: quote?.size ?? null, entry };
      const study = next.markets[ticker][studies[event.side]] ??= {};
      study[event.phase] = sample;
      return sample;
    });
    this.persist(next);
    this.failedRetestTrackers = trackers;
    for (const sample of samples) {
      this.emit({ event: sample.side === 'yes' ? 'FAILED_PULLBACK_PAPER' : 'FAILED_RETEST_PAPER',
        ticker, ...sample });
      if (sample.side === 'no' && sample.phase === 'confirmed' && sample.entry) {
        this.onBearishRetest?.({ ticker, close, signalAt: sample.signalAt,
          breakLevel: sample.priorLow - rules.breakBelowLow, maxAsk: sample.downAsk,
          maxQuoteDelayMs: rules.maxQuoteDelayMs, budget: rules.paperBudget,
          feeMultiplier: row.feeMultiplier });
      }
    }
  }
  async observeRangeScalp() {
    const market = this.current;
    if (!market) return;
    const ticker = market.ticker;
    const row = this.state.markets[ticker];
    const close = Date.parse(market.close_time);
    const now = this.now();
    if (!row || now >= close) return;
    if (this.rangeScalpTicker !== ticker) {
      this.rangeScalpTicker = ticker;
      this.rangeScalp = structuredClone(row.rangeScalp ?? {});
      this.structureScalp = structuredClone(row.structureScalp ?? { up: {}, down: {} });
    }
    const baseline = structuredClone(this.rangeScalp);
    const structure = structuredClone(this.structureScalp);
    const cases = [
      { study: baseline, variant: null },
      { study: structure.up, variant: 'structure', leg: 'up' },
      { study: structure.down, variant: 'structure', leg: 'down' },
    ];
    const open = Math.max(Date.parse(market.open_time), row.startedAt);
    const history = this.feed?.getHistory?.('BTC') ?? [];
    let changed = false;
    const changes = [];
    for (const test of cases) {
      const { study, leg } = test;
      test.prior = { ...study };
      if (leg) advanceBtcStructureScalp(study, leg, history, open, close, now);
      else advanceBtcRangeScalp(study, history, open, close, now);
      for (const phase of ['downSignal', 'supportTouch', 'upSignal', 'invalidated']) {
        if (!test.prior[phase] && study[phase]) {
          changes.push({ variant: test.variant, leg, phase,
            ...(phase === 'invalidated' ? { reason: study[phase] } : study[phase]) });
        }
      }
    }
    const active = cases.filter(({ study }) => btcRangeScalpNeedsBook(study, now, close));
    if (active.length) {
      try {
        const data = await this.read('/markets/' + ticker + '/orderbook?depth=1');
        const book = metalBook(data), at = this.now();
        for (const { study, variant, leg, prior } of active) {
          const samples = sampleBtcRangeScalp(study, book, row.feeMultiplier, now, at, close,
            { downProfitTarget: leg === 'down' && study.downSignal?.support == null });
          for (const sample of samples) changes.push({ variant, leg, ...sample });
          changed ||= prior.downExitReason !== study.downExitReason ||
            prior.upExitReason !== study.upExitReason;
        }
      } catch (error) {
        this.emit({ event: 'RANGE_SCALP_QUOTE_ERROR', ticker, message: error.message });
      }
    }
    if (changes.length || changed) {
      this.persist({ ...this.state, markets: { ...this.state.markets,
        [ticker]: { ...row, rangeScalp: baseline, structureScalp: structure } } });
      for (const { variant, leg, ...change } of changes) {
        this.emit(variant ? { event: 'STRUCTURE_SCALP_PAPER', ticker, leg, ...change } :
          { event: 'RANGE_SCALP_PAPER', ticker, ...change });
      }
    }
    this.rangeScalp = baseline;
    this.structureScalp = structure;
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
    updateWickTotals(next.wickTotals??={},r);
    const closed=Object.values(next.markets).filter(r=>r.result).sort((a,b)=>b.settledAt-a.settledAt);
    for(const old of closed.slice(512))delete next.markets[old.ticker];
    for (const [study, side] of [[r.failedRetest, 'no'], [r.failedPullback, 'yes']]) {
      if (!study) continue;
      const { turn, confirmed, invalidated } = study;
      const outcome = sample => sample?.entry
        ? (r.result === side ? sample.entry.count : 0) - sample.entry.estimatedCost : null;
      study.outcome = { turnNet: outcome(turn), confirmedNet: outcome(confirmed),
        confirmed: Boolean(confirmed), invalidated: invalidated?.reason ?? null };
    }
    this.persist(next,{event:'SETTLED_ESTIMATE',ticker:r.ticker,result:r.result,entry:c,
      estimatedCost:r.estimatedCost,hypotheticalPayout:r.payout,hypotheticalNet:r.net,
      wickComparison:wickOutcome(r),wickTotals:next.wickTotals,experiments:experimentOutcome(r),chartReversal:chartOutcome(r),wickRejectionScalps:wickRejectionScalpOutcomes(r),
      failedRetest:r.failedRetest,failedPullback:r.failedPullback,rangeScalp:btcRangeScalpOutcome(r.rangeScalp,r.result),
      structureScalp:r.structureScalp && Object.fromEntries(['up','down'].map(leg =>
        [leg, btcRangeScalpOutcome(r.structureScalp[leg],r.result)?.[leg]])),
      partialWindow:r.startedAt>Date.parse(r.closeTime)-90000,
      filtersNotEvaluated:['account-risk','available-cash','combined-live-exposure']});
  }
  async tick(){if(this.busy)return;this.busy=true;try{
    try{await this.discover();await this.observe();}catch(e){this.emit({event:'READ_ERROR',message:e.message});}
    try{await this.observeFailedRetest();}catch(e){this.emit({event:'FAILED_RETEST_READ_ERROR',message:e.message});}
    try{await this.observeRangeScalp();}catch(e){this.emit({event:'RANGE_SCALP_READ_ERROR',message:e.message});}
    try{await this.settleOne();}catch(e){this.emit({event:'SETTLEMENT_ERROR',message:e.message});}
  }finally{this.busy=false;}}
  start(){this.emit({event:'STARTED',rules:BTC_LARGE_RULES,priceCap:null,liveOrders:false,
    failedRetestPaper:BTC_FAILED_RETEST_RULES,failedPullbackPaper:BTC_FAILED_RETEST_RULES,rangeScalpPaper:BTC_RANGE_SCALP_RULES,structureScalpPaper:BTC_STRUCTURE_RULES,
    executionModel:'ONE_SNAPSHOT_PER_WINDOW_TOP_LEVEL_VOLUME_NO_FILL_RETRIES'});
    void this.tick();this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref?.();return this;}
  stop(){clearInterval(this.timer);}
}
