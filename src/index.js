/**
 * Entry point. Two modes:
 *
 * 1. MCP mode (--mcp flag, or used by Claude Desktop):
 *    node src/index.js --mcp
 *    - Redirects console.log → stderr so stdout stays clean for MCP protocol
 *    - Starts clock + MCP server on stdio
 *    - No terminal UI
 *
 * 2. Terminal mode (npm start, interactive):
 *    node src/index.js
 *    - Starts clock + blessed terminal dashboard
 *    - No MCP server
 */

import 'dotenv/config';

const MCP_MODE = process.argv.includes('--mcp') || !process.stdout.isTTY;

// In MCP mode stdout is the protocol pipe — redirect all logging to stderr
if (MCP_MODE) {
  const _log = console.log.bind(console);
  console.log  = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.warn = (...a) => process.stderr.write('[WARN] ' + a.join(' ') + '\n');
}

console.log(`[Boot] Kalshi MCP Bot — ${MCP_MODE ? 'MCP' : 'Terminal'} mode`);

import { startClock } from './engine/clock.js';
import { state } from './engine/state.js';
import { LIVE_LATE_MARKETS } from './engine/lateMarkets.js';

async function main() {
  await startClock();

  import('./engine/cryptoWickRunner.js').then(({ startCryptoWickRunner }) => startCryptoWickRunner())
    .catch(e => console.error('[CRYPTO_WICK] Startup failed:', e.message));

  if (process.env.LATE_MARKETS_LIVE_ENABLED !== 'false' ||
      Object.keys(LIVE_LATE_MARKETS).some(asset=>state[asset].activeTrade)) {
    import('./engine/lateMarketRunner.js').then(({ startLateMarketRunner }) => startLateMarketRunner())
      .catch(e => console.error('[LATE_MARKETS] Startup failed:', e.message));
  }

  if (MCP_MODE) {
    const { startMCPServer } = await import('./mcp/server.js');
    await startMCPServer();
  } else {
    const { startTerminal } = await import('./ui/terminal.js');
    startTerminal();
  }
}

main().catch(err => {
  process.stderr.write(`[Fatal] ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
