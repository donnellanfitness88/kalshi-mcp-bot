import { state } from './state.js';
import { scalpExecutor } from './scalpExecution.js';
import { LIVE_LATE_MARKETS, fourMarketsEnabled, isPilotWick, pilotWickEnabled,
  PILOT_WICK_BUDGET, PILOT_WICK_CUTOFF_SECONDS } from './lateMarkets.js';
import { metalBook } from '../research/metalsObserver.js';

const MAX_EXECUTABLE_BOOK_AGE_MS = 2000;

// Reuse the observer's existing discovery and Pyth connections. The observer
// itself remains read-only. Only the shared journaled executor can send orders.
export class LateMarketRunner {
  constructor(observer,{shared=state,executor=scalpExecutor,now=Date.now,
    log=event=>console.log('[LATE_MARKETS] '+JSON.stringify(event))}={}) {
    Object.assign(this,{observer,shared,executor,now,log});this.busy=false;
  }
  async refreshQuote(asset) {
    const s=this.shared[asset], market=this.observer.current[asset];
    s.lastQuoteMessageTs=0;
    if (!market || market.ticker!==s.ticker || !['open','active'].includes(market.status))
      throw new Error('Live market no longer current');
    const ticker=s.ticker, closeTime=Date.parse(market.close_time), started=this.now();
    let receivedAt=null, checkedAt=null, outcome='READ_ERROR', deadlineAborted=false;
    const signal=AbortSignal.timeout(MAX_EXECUTABLE_BOOK_AGE_MS);
    try {
      const data=await this.observer.read('/markets/'+encodeURIComponent(ticker)+'/orderbook?depth=1',{signal});
      receivedAt=this.now();
      const book=metalBook(data);
      checkedAt=this.now();
      const elapsed=checkedAt-started;
      if(elapsed<0 || elapsed>MAX_EXECUTABLE_BOOK_AGE_MS) outcome='EXECUTABLE_BOOK_STALE_RESPONSE';
      else if(!book) outcome='EXECUTABLE_BOOK_INVALID_OR_CROSSED';
      else if(!book.yes && !book.no) outcome='EXECUTABLE_BOOK_EMPTY';
      else outcome='ACCEPTED';
      if(outcome!=='ACCEPTED') throw new Error(outcome);

      // Preserve absent quotes as absent. Never invent an opposite bid or offer.
      s.lateBook=book;
      s.yesAsk=book.yes?.price??null;s.yesBid=book.yesBid;
      s.yesAskSize=book.yes?.size??0;s.noAskSize=book.no?.size??0;
      // Age is measured from request start, not response completion.
      s.lastQuoteMessageTs=started;
    } catch(error) {
      if(!signal.aborted || outcome!=='READ_ERROR') throw error;
      deadlineAborted=true;
      outcome='EXECUTABLE_BOOK_STALE_RESPONSE';
      throw new Error(outcome,{cause:error});
    } finally {
      const completedAt=receivedAt??this.now();
      this.log({event:'EXECUTABLE_BOOK_TIMING',asset,ticker,outcome,
        requestMs:completedAt-started,bookAgeMs:checkedAt===null?null:checkedAt-started,
        limitMs:MAX_EXECUTABLE_BOOK_AGE_MS,deadlineAborted,
        secondsRemainingAtStart:(closeTime-started)/1000,
        secondsRemainingAtCompletion:(closeTime-completedAt)/1000});
    }
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    try {
      for(const asset of Object.keys(LIVE_LATE_MARKETS)) {
        const s=this.shared[asset];if(!s)continue;
        const market=this.observer.current[asset];
        if(market) {
          s.ticker=market.ticker;s.marketCloseTs=Date.parse(market.close_time);
          const series=this.observer.series[asset];
          s.lateFeeType=series?.fee_type;
          s.lateFeeMultiplier=series?.fee_multiplier==null?NaN:Number(series.fee_multiplier);
        } else s.lastQuoteMessageTs=0;
        try {
          // Also service restored holdings when closed, disabled, or no feed exists.
          if(!s.activeTrade && (!fourMarketsEnabled() || !market || (isPilotWick(asset) && !pilotWickEnabled())))continue;
          await this.executor.tick({asset,s,balance:this.shared.balance,
            proxy:this.observer.proxy,refreshQuote:()=>this.refreshQuote(asset)});
        } catch(error) {this.log({event:'ERROR',asset,message:error.message});}
      }
    } finally {this.busy=false;}
  }
  start() {
    this.log({event:'STARTED',enabled:fourMarketsEnabled(),markets:LIVE_LATE_MARKETS,
      capPerMarket:1082,totalCapIncludingBTC:5410,largeBTC:'OBSERVATION_ONLY',
      pilotWick:{enabled:fourMarketsEnabled() && pilotWickEnabled(),budgetPerMarket:PILOT_WICK_BUDGET,
        cutoffSeconds:PILOT_WICK_CUTOFF_SECONDS},
      reference:'PYTH_SPOT_PROXY_NOT_SETTLEMENT',fixedMinimum:null,
      rapidDropFraction:.30,recoverySeconds:2});
    void this.tick();this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref?.();return this;
  }
  stop(){clearInterval(this.timer);}
}
export const startLateMarketRunner=observer=>new LateMarketRunner(observer).start();
