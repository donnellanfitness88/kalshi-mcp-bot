import { activeMetalMarket, estimateMetalEntry, publicMetalRead } from '../research/metalsObserver.js';
import { MetalsProxy } from '../research/metalsProxy.js';
import { FALLING_NINETY_BUDGET, LIVE_LATE_MARKETS, fallingNinetyEnabled, isPilotWick } from './lateMarkets.js';

const validTarget = market => {
  const value=market?.floor_strike;
  return ['number','string'].includes(typeof value) &&
    Number.isFinite(Number(value)) && Number(value)>0;
};

export class LiveLateMarketData {
  constructor({read=publicMetalRead, proxy, now=Date.now,
    log=event=>console.log('[LIVE_LATE_DATA] '+JSON.stringify(event))}={}) {
    Object.assign(this,{read,proxy,now,log});
    this.current={};
    this.series={};
    this.nextDiscovery={};
    this.nextTargetRead={};
    this.pending=new Set();
    this.fallingPaths=new Map();
  }

  async refreshAsset(asset) {
    const at=this.now();
    const current=this.current[asset];
    const active=current && Date.parse(current.close_time)>at;
    const discover=at>=(this.nextDiscovery[asset]??0);
    const refreshTarget=active && isPilotWick(asset) && fallingNinetyEnabled() &&
      !validTarget(current) && at>=(this.nextTargetRead[asset]??0);
    if ((!discover && !refreshTarget) || this.pending.has(asset)) return;
    this.pending.add(asset);
    try {
      const {series:ticker}=LIVE_LATE_MARKETS[asset];
      if (!this.series[asset]) {
        const {series}=await this.read('/series/'+ticker);
        if (series?.ticker!==ticker || series.frequency!=='fifteen_min')
          throw new Error('Unexpected live series metadata');
        this.series[asset]=series;
      }
      if (discover) {
        this.nextDiscovery[asset]=at+5000;
        const query=new URLSearchParams({series_ticker:ticker,status:'open',limit:'100'});
        const data=await this.read('/markets?'+query);
        const previous=this.current[asset];
        const market=activeMetalMarket(data.markets,asset,this.now());
        // Preserve a separately verified strike when discovery omits it.
        if (market && market.ticker===previous?.ticker && validTarget(previous) && !validTarget(market))
          market.floor_strike=previous.floor_strike;
        this.current[asset]=market;
        if (market) this.nextDiscovery[asset]=Math.min(this.now()+60000,Date.parse(market.close_time));
      }
      const market=this.current[asset];
      if (market && isPilotWick(asset) && fallingNinetyEnabled() && !validTarget(market) &&
          this.now()>=(this.nextTargetRead[asset]??0)) {
        this.nextTargetRead[asset]=this.now()+15000;
        const {market:details}=await this.read('/markets/'+encodeURIComponent(market.ticker));
        if (details?.ticker===market.ticker && validTarget(details)) market.floor_strike=details.floor_strike;
      }
    } catch (error) {
      this.log({event:'METADATA_READ_ERROR',asset,message:error.message});
    } finally {
      this.pending.delete(asset);
    }
  }

  async refreshMarkets() {
    await Promise.all(Object.keys(LIVE_LATE_MARKETS).map(asset=>this.refreshAsset(asset)));
  }

  canSampleFalling(asset) {
    return isPilotWick(asset) && fallingNinetyEnabled() &&
      this.proxy?.snapshot(asset,null,null)?.status==='FRESH_PROXY';
  }

  sampleFallingBook(asset, market, book, started) {
    const at=this.now();
    if (this.current[asset]?.ticker!==market.ticker || at>=Date.parse(market.close_time) ||
        at<started || at-started>2000 || !this.canSampleFalling(asset)) return;
    let track=this.fallingPaths.get(asset);
    if (track?.ticker!==market.ticker) {
      track={ticker:market.ticker,previous:{},signal:null};
      this.fallingPaths.set(asset,track);
    }
    track.signal=null;
    const sides=['yes','no'].filter(side=>book[side]?.price===0.90 && book[side].size>0);
    if (sides.length===1 && validTarget(market)) {
      const [side]=sides;
      const previous=track.previous[side];
      const series=this.series[asset];
      if (previous?.price>0.90 && at-previous.at<=60000 && series?.fee_type==='quadratic' &&
          estimateMetalEntry({book,side,stage:{minPrice:0.90,budget:FALLING_NINETY_BUDGET},
            feeMultiplier:Number(series.fee_multiplier)})) {
        track.signal={ticker:market.ticker,side,at,target:Number(market.floor_strike),direction:'falling'};
      }
    }
    for (const side of ['yes','no']) {
      const price=book[side]?.price;
      if (Number.isFinite(price) && price!==0.90) track.previous[side]={price,at};
    }
  }

  getFallingNinetySignal(asset) {
    const track=this.fallingPaths.get(asset);
    return track?.ticker===this.current[asset]?.ticker ? track?.signal : undefined;
  }
}

export function startLiveLateMarketData() {
  const data=new LiveLateMarketData();
  data.proxy=new MetalsProxy({log:data.log}).start(process.env.PYTH_PRO_API_KEY);
  void data.refreshMarkets();
  return data;
}
