import { state } from './state.js';
import { scalpExecutor } from './scalpExecution.js';
import { LIVE_LATE_MARKETS, fourMarketsEnabled, isPilotWick, pilotWickEnabled,
  FALLING_NINETY_BUDGET, fallingNinetyEnabled, PILOT_WICK_BUDGET, PILOT_WICK_CUTOFF_SECONDS } from './lateMarkets.js';
import { metalBook } from '../research/metalsObserver.js';

const MAX_EXECUTABLE_BOOK_AGE_MS = 2000;
const BATCH_RETRY_DELAY_MS = 60000;
const batchBooksEnabled = () => process.env.LATE_MARKETS_BATCH_BOOKS_ENABLED !== 'false';

// Reuse the observer's existing discovery and Pyth connections. The observer
// itself remains read-only. Only the shared journaled executor can send orders.
export class LateMarketRunner {
  constructor(observer,{shared=state,executor=scalpExecutor,now=Date.now,
    log=event=>console.log('[LATE_MARKETS] '+JSON.stringify(event))}={}) {
    Object.assign(this,{observer,shared,executor,now,log});this.busy=false;
    this.nextBatchAttemptAt=0;
  }
  applyBook(s, book, started) {
    // Keep the original request timestamp and preserve absent sides.
    s.lateBook=book;
    s.yesAsk=book.yes?.price??null;s.yesBid=book.yesBid;
    s.yesAskSize=book.yes?.size??0;s.noAskSize=book.no?.size??0;
    s.lastQuoteMessageTs=started;
  }
  async prefetchBooks(scanAt) {
    if(!batchBooksEnabled() || !fourMarketsEnabled() || process.env.SCALP_ENABLED!=='true' ||
        scanAt<this.nextBatchAttemptAt) return null;
    const tickers=Object.keys(LIVE_LATE_MARKETS).flatMap(asset=>{
      const s=this.shared[asset], market=this.observer.current[asset];
      const remaining=Date.parse(market?.close_time)-scanAt;
      if(!s?.farmArmed || this.shared.disabledAssets?.includes(asset) || !['open','active'].includes(market?.status) ||
          !(remaining>0 && remaining<180000) || (isPilotWick(asset) && !pilotWickEnabled())) return [];
      return [market.ticker];
    });
    if(tickers.length<2) return null;
    const path='/markets/orderbooks?'+new URLSearchParams(tickers.map(ticker=>['tickers',ticker]));
    const started=this.now(), signal=AbortSignal.timeout(MAX_EXECUTABLE_BOOK_AGE_MS), books=new Map();
    let outcome='ACCEPTED';
    try {
      const data=await this.observer.read(path,{signal});
      if(!Array.isArray(data?.orderbooks)) throw new Error('Invalid batch order-book response');
      const expected=new Set(tickers);
      for(const row of data.orderbooks) {
        if(!expected.delete(row?.ticker)) throw new Error('Unexpected or duplicate batch ticker');
        const book=metalBook(row);
        if(book?.yes || book?.no) books.set(row.ticker,book);
      }
      const age=this.now()-started;
      if(age<0 || age>MAX_EXECUTABLE_BOOK_AGE_MS) throw new Error('Stale batch order-book response');
      if(!books.size) throw new Error('No usable batch order books');
      return {started,books};
    } catch(error) {
      outcome=signal.aborted?'DEADLINE_ABORTED':error.message;
      this.nextBatchAttemptAt=this.now()+BATCH_RETRY_DELAY_MS;
      books.clear();
      return null;
    } finally {
      this.log({event:'BATCH_BOOK_TIMING',outcome,requested:tickers.length,usable:books.size,
        requestMs:this.now()-started,limitMs:MAX_EXECUTABLE_BOOK_AGE_MS});
    }
  }
  async refreshInitialQuote(asset, batch) {
    const s=this.shared[asset], market=this.observer.current[asset];
    const book=batch?.books.get(s.ticker), now=this.now(), age=now-batch?.started;
    if(book && age>=0 && age<=MAX_EXECUTABLE_BOOK_AGE_MS && market?.ticker===s.ticker &&
        ['open','active'].includes(market.status) && Date.parse(market.close_time)>now) {
      this.applyBook(s,book,batch.started);
      this.log({event:'BATCH_BOOK_USED',asset,ticker:s.ticker,bookAgeMs:age});
      return;
    }
    await this.refreshQuote(asset,'INITIAL');
  }
  async refreshQuote(asset, phase) {
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

      this.applyBook(s,book,started);
    } catch(error) {
      if(!signal.aborted || outcome!=='READ_ERROR') throw error;
      deadlineAborted=true;
      outcome='EXECUTABLE_BOOK_STALE_RESPONSE';
      throw new Error(outcome,{cause:error});
    } finally {
      const completedAt=receivedAt??this.now();
      this.log({event:'EXECUTABLE_BOOK_TIMING',asset,ticker,outcome,phase,
        requestMs:completedAt-started,bookAgeMs:checkedAt===null?null:checkedAt-started,
        limitMs:MAX_EXECUTABLE_BOOK_AGE_MS,deadlineAborted,
        secondsRemainingAtStart:(closeTime-started)/1000,
        secondsRemainingAtCompletion:(closeTime-completedAt)/1000});
    }
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    const scanAt=this.now();
    try {
      const batch=await this.prefetchBooks(scanAt);
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
          if(!s.activeTrade && (!fourMarketsEnabled() || !market || (isPilotWick(asset) && !pilotWickEnabled() && !fallingNinetyEnabled())))continue;
          if(market && s.marketCloseTs>this.now() && s.marketCloseTs-this.now()<180000)
            this.log({event:'MARKET_SCAN_TIMING',asset,ticker:s.ticker,queueWaitMs:this.now()-scanAt});
          await this.executor.tick({asset,s,balance:this.shared.balance,
            proxy:this.observer.proxy,refreshQuote:phase=>this.refreshQuote(asset,phase),
            refreshInitialQuote:()=>this.refreshInitialQuote(asset,batch),
            getFallingNinetySignal:()=>this.observer.getFallingNinetySignal?.(asset)});
        } catch(error) {this.log({event:'ERROR',asset,message:error.message});}
      }
    } finally {this.busy=false;}
  }
  start() {
    this.log({event:'STARTED',enabled:fourMarketsEnabled(),markets:LIVE_LATE_MARKETS,batchBooksEnabled:batchBooksEnabled(),
      capPerMarket:1082,totalCapIncludingBTC:5410,largeBTC:'OBSERVATION_ONLY',
      pilotWick:{enabled:fourMarketsEnabled() && pilotWickEnabled(),budgetPerMarket:PILOT_WICK_BUDGET,
        cutoffSeconds:PILOT_WICK_CUTOFF_SECONDS},
      fallingNinety:{enabled:fourMarketsEnabled() && fallingNinetyEnabled(),budgetPerMarket:FALLING_NINETY_BUDGET},
      reference:'PYTH_SPOT_PROXY_NOT_SETTLEMENT',fixedMinimum:null,
      rapidDropFraction:.30,recoverySeconds:2});
    void this.tick();this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref?.();return this;
  }
  stop(){clearInterval(this.timer);}
}
export const startLateMarketRunner=observer=>new LateMarketRunner(observer).start();
