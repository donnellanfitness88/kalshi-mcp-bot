// Read-only observation. Returned estimates assume displayed top-level volume survives.
export class NinetyStudy {
  constructor({fallingOnly=false,budget=900}={}) {
    this.fallingOnly=fallingOnly;
    this.budget=budget;
    this.assets = new Map();
  }
  sample({asset, row, book, proxy, at, started, estimate}) {
    let state = this.assets.get(asset);
    if (!state) {
      state = {points:new Map(), lastSource:0};
      this.assets.set(asset,state);
    }
    const ref = proxy?.snapshot(asset,row.target,null);
    if (ref?.status === 'FRESH_PROXY' && ref.sourceAt > state.lastSource) {
      if (ref.sourceAt - state.lastSource > 20000) state.points.clear();
      state.lastSource = ref.sourceAt;
      const bucket = Math.floor(ref.sourceAt/5000);
      state.points.set(bucket,{at:ref.sourceAt,price:ref.price});
      while (state.points.keys().next().value < bucket-2884)
        state.points.delete(state.points.keys().next().value);
    }
    if (state.ticker !== row.ticker) {
      Object.assign(state,{ticker:row.ticker,path:[],first:at,last:at,maxGap:0,crossings:0,lastSign:0,target:null});
    }
    state.maxGap = Math.max(state.maxGap,at-state.last);
    state.last = at;
    if (state.target !== row.target) {
      state.target=row.target; state.crossings=0; state.lastSign=0;
    }
    if (Number.isFinite(row.target) && ref?.status==='FRESH_PROXY') {
      const sign=Math.sign(ref.price-row.target);
      if (sign && state.lastSign && sign!==state.lastSign) state.crossings++;
      if (sign) state.lastSign=sign;
    }
    if ((!this.fallingOnly && row.study90) || !book) return null;
    const sides = ['yes','no'].filter(s=>book[s]?.price===0.90 && book[s].size>0);
    state.path = state.path.filter(p=>at-p.at<=60000);
    const previous = {};
    for (const side of sides)
      previous[side] = state.path.findLast(p=>p[side]!=null && p[side]!==0.90)?.[side];
    state.path.push({at,yes:book.yes?.price??null,no:book.no?.price??null,spot:ref?.price??null});
    if (!sides.length) return null;
    const side=sides[0];
    if (this.fallingOnly && (sides.length!==1 || !(previous[side]>.90))) return null;
    const p=proxy?.snapshot(asset,row.target,side);
    const cutoff=(p?.sourceAt??0)-14400000, bucket=Math.floor(cutoff/5000);
    const prior=[bucket,bucket-1,bucket-2,bucket-3,bucket-4].map(b=>state.points.get(b))
      .find(v=>v && v.at<=cutoff && cutoff-v.at<=20000);
    const trend=p?.status==='FRESH_PROXY' && prior
      ? (side==='yes'?1:-1)*(p.price/prior.price-1) : null;
    const plan=row.feeType==='quadratic'
      ? estimate({book,stage:{minPrice:.90,budget:this.budget},side,feeMultiplier:row.feeMultiplier}) : null;
    return {side,at,started,firstSample:state.first,maxSampleGapMs:state.maxGap,
      ambiguous:sides.length>1,secondsLeft:(Date.parse(row.closeTime)-at)/1000,
      direction:previous[side]==null?'unknown':previous[side]<.90?'rising':'falling',
      observedTargetCrossings:state.crossings,displayedSize:book[side].size,target:row.target,proxy:p??null,signedFourHourReturn:trend,
      priorReference:prior??null,path:[...state.path],plan};
  }
}
