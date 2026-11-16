import WebSocket from 'ws';

// Research only. These are spot proxies, NOT Kalshi's settlement indices.
export const PROXY_FEEDS = {GOLD:{id:346,symbol:'Metal.XAU/USD',quoteUnit:'USD',pipSize:null},
  SILVER:{id:345,symbol:'Metal.XAG/USD',quoteUnit:'USD',pipSize:null},
  EURUSD:{id:327,symbol:'FX.EUR/USD',quoteUnit:'USD per EUR',pipSize:.0001},
  USDJPY:{id:340,symbol:'FX.USD/JPY',quoteUnit:'JPY per USD',pipSize:.01}};
const URLS = [0,1,2].map(i=>`wss://pyth-lazer-${i}.dourolabs.app/v1/stream`);
const numeric = v => (typeof v==='number' || typeof v==='string' && v.trim()!=='') ? Number(v) : NaN;

export class MetalsProxy {
  constructor({now=Date.now,log=()=>{},Socket=WebSocket}={}) {
    Object.assign(this,{now,log,Socket}); this.history=Object.fromEntries(Object.keys(PROXY_FEEDS).map(a=>[a,[]])); this.sockets=[];this.timers=new Set();
  }
  ingest(message) {
    if(message?.type!=='streamUpdated' || ![1,2].includes(message.subscriptionId) || !Array.isArray(message.parsed?.priceFeeds))return;
    for(const row of message.parsed.priceFeeds) {
      const asset=Object.keys(PROXY_FEEDS).find(a=>PROXY_FEEDS[a].id===row.priceFeedId);
      if(!asset)continue;
      if(message.subscriptionId!==(['EURUSD','USDJPY'].includes(asset)?2:1))continue;
      const exponent=numeric(row.exponent), mantissa=numeric(row.price), sourceAt=numeric(row.feedUpdateTimestamp)/1000;
      const price=mantissa/10**(-exponent), at=this.now(), age=at-sourceAt;
      if(!Number.isInteger(exponent)||exponent < -18||exponent>0||!Number.isSafeInteger(mantissa)||
        !Number.isFinite(price)||price<=0||!Number.isFinite(sourceAt)||age<0||age>2000||row.marketSession!=='regular')continue;
      const history=this.history[asset], last=history.at(-1);
      if(last && sourceAt<=last.sourceAt)continue; // Includes duplicates from redundant sockets.
      const confidence=numeric(row.confidence)/10**(-exponent);
      const point={sourceAt,receivedAt:at,price,confidence:Number.isFinite(confidence)&&confidence>=0?confidence:null};
      if(last && Math.floor(last.sourceAt/1000)===Math.floor(sourceAt/1000))history[history.length-1]=point;
      else history.push(point);
      this.history[asset]=history.filter(p=>sourceAt-p.sourceAt<=90000).slice(-100);
    }
  }
  snapshot(asset,target,side) {
    const history=this.history[asset]??[],last=history.at(-1), at=this.now();
    const meta={source:PROXY_FEEDS[asset]?.symbol??null,referenceType:'SPOT_PROXY_NOT_SETTLEMENT',
      quoteUnit:PROXY_FEEDS[asset]?.quoteUnit??null,pipSize:PROXY_FEEDS[asset]?.pipSize??null,
      officialReferencePrice:null,proxyIndexDifference:null};
    if(!last || at-last.sourceAt<0 || at-last.sourceAt>2000)return {...meta,status:'UNAVAILABLE_OR_STALE',price:null,estimatedCushion:null};
    const t=numeric(target),direction=side==='yes'?1:side==='no'?-1:null;
    const movement={};
    for(const seconds of [15,30,60]) {
      const cutoff=last.sourceAt-seconds*1000;
      const first=history.findLast(p=>p.sourceAt<=cutoff);
      const points=first?history.filter(p=>p.sourceAt>=first.sourceAt):[];
      const continuous=first && cutoff-first.sourceAt<=1500 && points.every((p,i)=>!i||p.sourceAt-points[i-1].sourceAt<=2500);
      movement[seconds]=continuous?{elapsedSeconds:(last.sourceAt-first.sourceAt)/1000,
        priceChange:last.price-first.price,range:Math.max(...points.map(p=>p.price))-Math.min(...points.map(p=>p.price)),
        cushionChange:direction===null?null:direction*(last.price-first.price)}:null;
    }
    const estimatedCushion=direction!==null && Number.isFinite(t)&&t>0?direction*(last.price-t):null;
    return {...meta,status:'FRESH_PROXY',price:last.price,sourceAt:last.sourceAt,ageMs:at-last.sourceAt,
      confidence:last.confidence,estimatedCushion,
      estimatedCushionPips:estimatedCushion!==null&&meta.pipSize?estimatedCushion/meta.pipSize:null,movement};
  }
  start(key) {
    if(!key){this.log({event:'PROXY_DISABLED',reason:'PYTH_PRO_API_KEY_NOT_SET'});return this;}
    this.stopped=false;
    this.log({event:'PROXY_STARTED',feeds:PROXY_FEEDS,referenceType:'SPOT_PROXY_NOT_SETTLEMENT'});
    URLS.forEach((url,index)=>this.connect(url,index,key));return this;
  }
  connect(url,index,key) {
    if(this.stopped)return;
    let ws;
    try { ws=new this.Socket(url,{headers:{Authorization:`Bearer ${key}`},handshakeTimeout:10000,maxPayload:1048576}); }
    catch {this.log({event:'PROXY_CONNECTION_ERROR',endpoint:index});return;}
    this.sockets[index]=ws;
    let alive=true, denied=false;
    const heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;if(ws.readyState===1)ws.ping();},15000);
    heartbeat.unref?.();
    ws.on('pong',()=>{alive=true;});
    ws.on('open',()=>{
      if(this.stopped){ws.close();return;}
      ws.send(JSON.stringify({type:'subscribe',subscriptionId:1,priceFeedIds:[346,345],
        properties:['price','exponent','confidence','feedUpdateTimestamp','marketSession'],formats:[],channel:'fixed_rate@200ms',ignoreInvalidFeeds:true}));
      // Separate subscription: an FX entitlement rejection must not stop metals.
      ws.send(JSON.stringify({type:'subscribe',subscriptionId:2,priceFeedIds:[327,340],
        properties:['price','exponent','confidence','feedUpdateTimestamp','marketSession'],formats:[],channel:'fixed_rate@200ms',ignoreInvalidFeeds:true}));
    });
    ws.on('message',data=>{
      try {const message=JSON.parse(data.toString());
        if(message.type==='subscriptionError') {
          if(message.subscriptionId===2){this.log({event:'PROXY_SUBSCRIPTION_ERROR',endpoint:index,subscriptionId:2});return;}
          denied=true;this.log({event:'PROXY_SUBSCRIPTION_ERROR',endpoint:index});ws.close();
        } else this.ingest(message);
      } catch {} // Do not print payloads or credentials.
    });
    ws.on('unexpected-response',(_req,res)=>{
      denied=[401,403].includes(res.statusCode);
      this.log({event:'PROXY_HANDSHAKE_ERROR',endpoint:index,httpStatus:res.statusCode});
      res.resume();ws.terminate();
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{
      clearInterval(heartbeat);
      if(!this.stopped&&!denied){const timer=setTimeout(()=>{this.timers.delete(timer);this.connect(url,index,key);},10000);
        timer.unref?.();this.timers.add(timer);}
    });
  }
  stop(){this.stopped=true;for(const timer of this.timers)clearTimeout(timer);this.timers.clear();for(const ws of this.sockets)ws?.terminate();}
}
