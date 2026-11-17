import { state } from './state.js';
import { scalpExecutor } from './scalpExecution.js';
import { LIVE_LATE_MARKETS, fourMarketsEnabled } from './lateMarkets.js';
import { metalBook } from '../research/metalsObserver.js';

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
    const started=this.now();
    const data=await this.observer.read('/markets/'+encodeURIComponent(s.ticker)+'/orderbook?depth=1');
    const book=metalBook(data);
    const elapsed=this.now()-started;
    if(elapsed<0 || elapsed>2000) throw new Error('EXECUTABLE_BOOK_STALE_RESPONSE');
    if(!book) throw new Error('EXECUTABLE_BOOK_INVALID_OR_CROSSED');
    if(!book.yes && !book.no) throw new Error('EXECUTABLE_BOOK_EMPTY');
    // Preserve absent quotes as absent. Never invent an opposite bid or offer.
    s.lateBook=book;
    s.yesAsk=book.yes?.price??null;s.yesBid=book.yesBid;
    s.yesAskSize=book.yes?.size??0;s.noAskSize=book.no?.size??0;
    // Age is measured from request start, not response completion.
    s.lastQuoteMessageTs=started;
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
          if(!s.activeTrade && (!fourMarketsEnabled() || !market))continue;
          await this.executor.tick({asset,s,balance:this.shared.balance,
            proxy:this.observer.proxy,refreshQuote:()=>this.refreshQuote(asset)});
        } catch(error) {this.log({event:'ERROR',asset,message:error.message});}
      }
    } finally {this.busy=false;}
  }
  start() {
    this.log({event:'STARTED',enabled:fourMarketsEnabled(),markets:LIVE_LATE_MARKETS,
      capPerMarket:182,totalCapIncludingBTC:910,largeBTC:'OBSERVATION_ONLY',
      reference:'PYTH_SPOT_PROXY_NOT_SETTLEMENT',fixedMinimum:null,
      rapidDropFraction:.30,recoverySeconds:2});
    void this.tick();this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref?.();return this;
  }
  stop(){clearInterval(this.timer);}
}
export const startLateMarketRunner=observer=>new LateMarketRunner(observer).start();
