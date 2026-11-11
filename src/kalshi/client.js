import crypto from 'crypto';
import 'dotenv/config';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

function normalizePEM(pem) {
  return pem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
}

function buildHeaders(method, kalshiPath) {
  const keyId = process.env.KALSHI_KEY_ID;
  const privateKey = normalizePEM(process.env.KALSHI_PRIVATE_KEY);

  const ts = Date.now().toString();
  // If the caller passes a path that already starts with /trade-api/ (e.g. the
  // WebSocket endpoint /trade-api/ws/v2), use it verbatim.  Otherwise prepend
  // the REST base prefix so that short paths like /portfolio/balance work.
  const rawPath = kalshiPath.split('?')[0];
  const pathNoQuery = rawPath.startsWith('/trade-api/')
    ? rawPath
    : '/trade-api/v2' + rawPath;
  const message = ts + method.toUpperCase() + pathNoQuery;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  const signature = sign.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');

  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
  };
}

async function request(method, path, body = null) {
  const headers = buildHeaders(method, path);
  const url = BASE_URL + path;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const raw = typeof data?.error === 'object' ? JSON.stringify(data.error) : (data?.error || data?.raw || res.statusText);
    throw new Error(`Kalshi ${method} ${path} → ${res.status}: ${raw}`);
  }

  return data;
}

// Portfolio
export async function getBalance() {
  const data = await request('GET', '/portfolio/balance');
  return data.balance;
}

export async function getPositions() {
  const data = await request('GET', '/portfolio/positions');
  return data.market_positions || [];
}

export async function getFillPage(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/portfolio/fills' + (qs ? '?' + qs : '');
  const data = await request('GET', path);

  return {
    fills: data.fills || [],
    cursor: data.cursor || null
  };
}

export async function getFills(params = {}) {
  const data = await getFillPage(params);
  return data.fills;
}
export async function getAllFills(params = {}) {
  const fills = [];
  const seenCursors = new Set();
  let cursor = null;

  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await getFillPage({
      ...params,
      limit: 200,
      ...(cursor ? { cursor } : {})
    });

    if (!Array.isArray(page.fills)) {
      throw new Error('Invalid Kalshi fills response');
    }

    fills.push(...page.fills);

    if (!page.cursor) {
      return fills;
    }

    if (seenCursors.has(page.cursor)) {
      throw new Error('Repeated Kalshi pagination cursor');
    }

    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  throw new Error('Fill pagination limit reached');
}
export async function getSettlementPage(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/portfolio/settlements' + (qs ? '?' + qs : '');
  const data = await request('GET', path);

  return {
    settlements: data.settlements || [],
    cursor: data.cursor || null
  };
}

export async function getSettlements(params = {}) {
  const data = await getSettlementPage(params);
  return data.settlements;
}export async function getAllSettlements(params = {}) {
  const settlements = [];
  const seenCursors = new Set();
  let cursor = null;

  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await getSettlementPage({
      ...params,
      limit: 200,
      ...(cursor ? { cursor } : {})
    });

    if (!Array.isArray(page.settlements)) {
      throw new Error('Invalid Kalshi settlements response');
    }

    settlements.push(...page.settlements);

    if (!page.cursor) {
      return settlements;
    }

    if (seenCursors.has(page.cursor)) {
      throw new Error('Repeated Kalshi settlement cursor');
    }

    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  throw new Error('Settlement pagination limit reached');
}
export async function getOrders(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/portfolio/orders' + (qs ? '?' + qs : '');
  const data = await request('GET', path);
  return data.orders || [];
}

// Markets
export async function getMarkets(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/markets' + (qs ? '?' + qs : '');
  const data = await request('GET', path);
  return data.markets || [];
}

export async function getMarket(ticker) {
  const data = await request('GET', `/markets/${ticker}`);
  return data.market;
}

export async function getMarketOrderbook(ticker) {
  return request(
    'GET',
    `/markets/${encodeURIComponent(ticker)}/orderbook?depth=0`
  );
}


// Find the active 15M market for an asset (BTC or ETH).
//
// Strategy: target the market closing at the NEXT 15-minute UTC boundary.
// This is more reliable than "any future market" because the new window's
// market often isn't status:'open' until 15–30s after the boundary, causing
// the old "any future" approach to either return the just-expired market or
// throw when nothing is listed yet.
export async function findActiveMarket(asset) {
  const series = asset === 'ETH' ? 'KXETH15M' : 'KXBTC15M';
  const markets = await getMarkets({ series_ticker: series, status: 'open' });
  if (!markets.length) throw new Error(`No open ${series} market found`);

  const now = Date.now();
  // The current window closes at the next 15-minute UTC mark.
  const targetCloseMs = (Math.floor(now / (15 * 60 * 1000)) + 1) * 15 * 60 * 1000;
  // ±90s tolerance: handles early lookups (new market not yet 'open') and
  // late lookups (clock skew / slow API propagation).
  const TOLERANCE_MS = 90_000;

  const matching = markets.filter(m => {
    const ct = new Date(m.close_time).getTime();
    return Math.abs(ct - targetCloseMs) <= TOLERANCE_MS;
  });

  if (matching.length > 0) {
    matching.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    return matching[0];
  }

  // Fallback: any market with a future close_time
  const future = markets.filter(m => new Date(m.close_time).getTime() > now);
  if (!future.length) throw new Error(`No future-expiring ${series} market found`);
  future.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  return future[0];
}

// Orders
export async function placeOrder(body) {
  if (process.env.DRY_RUN === 'true') {
    const sidePrice = body.yes_price_dollars
      ? parseFloat(body.yes_price_dollars)
      : 1 - parseFloat(body.no_price_dollars);
    console.log(`[DryRun] ${body.action.toUpperCase()} ${body.side.toUpperCase()} ×${body.count} ${body.ticker} @ ${sidePrice.toFixed(4)}`);
    return {
      order: {
        order_id: 'sim_' + Date.now().toString(36),
        status: 'executed',
        remaining_count: 0,
        action: body.action,
        side: body.side,
        count: body.count,
        ticker: body.ticker,
      },
    };
  }
  
return request('POST', '/portfolio/events/orders', body);

}

export async function cancelOrder(orderId) {
  if (process.env.DRY_RUN === 'true') return;
  return request('DELETE', `/portfolio/orders/${orderId}`);
}

export { buildHeaders, BASE_URL };
