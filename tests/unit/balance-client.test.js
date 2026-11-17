import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
process.env.KALSHI_KEY_ID='test';
process.env.KALSHI_PRIVATE_KEY=privateKey.export({type:'pkcs1',format:'pem'});

test('public client shares balance reads and retries only the balance GET on 429',async()=>{
  const original=global.fetch;let count=0;const urls=[];
  global.fetch=async(url,options)=>{
    count++;urls.push({url,method:options.method,at:performance.now()});
    if(count===1)return {ok:false,status:429,headers:{get:()=>'.1'},text:async()=>JSON.stringify({error:{code:'too_many_requests'}})};
    return {ok:true,text:async()=>JSON.stringify({balance:12345})};
  };
  try {
    const {getBalance}=await import('../../src/kalshi/client.js');
    assert.deepEqual(await Promise.all([getBalance(),getBalance()]),[12345,12345]);
    assert.equal(count,2);assert.ok(urls.every(x=>x.method==='GET'&&x.url.endsWith('/portfolio/balance')));
    assert.ok(urls[1].at-urls[0].at>=1090);
  }finally{global.fetch=original;}
});

test('indexed balances coalesce only within a shard and order lookup carries its shard',async()=>{
  const original=global.fetch,urls=[];
  global.fetch=async(url,options)=>{
    urls.push(url);
    const u=new URL(url),index=u.searchParams.get('exchange_index');
    return {ok:true,text:async()=>JSON.stringify(u.pathname.includes('/orders/')?
      {order:{order_id:'fx-order',ticker:'KXEURUSD15M-TEST'}}:{balance:index==='0'?123:456})};
  };
  try {
    const {getBalance,getOrder}=await import('../../src/kalshi/client.js');
    assert.deepEqual(await Promise.all([getBalance(0),getBalance(0),getBalance(2)]),[123,123,456]);
    assert.equal(urls.length,2);
    assert.equal((await getOrder('fx-order',0)).order_id,'fx-order');
    assert.ok(urls.at(-1).endsWith('/portfolio/orders/fx-order?exchange_index=0'));
  }finally{global.fetch=original;}
});
