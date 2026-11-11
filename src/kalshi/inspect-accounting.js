import {
  getFillPage,
  getSettlementPage
} from './client.js';

async function inspect(label, fetchPage) {
  try {
    const page = await fetchPage({ limit: 1 });
    const records = label === 'Fills'
      ? page.fills
      : page.settlements;

    console.log(`[${label}] Records returned: ${records.length}`);
    console.log(`[${label}] More pages: ${Boolean(page.cursor)}`);

    if (records.length) {
      console.log(
        `[${label}] Available fields:`,
        Object.keys(records[0]).sort().join(', ')
      );
    } else {
      console.log(`[${label}] No sample record available`);
    }
  } catch (error) {
    console.error(`[${label}] Request failed:`, error.message);
  }
}

await inspect('Fills', getFillPage);
await inspect('Settlements', getSettlementPage);