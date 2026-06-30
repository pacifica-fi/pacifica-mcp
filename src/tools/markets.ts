// src/tools/markets.ts — market data and exchange info tools.
// Moved verbatim from src/index.ts in the Tier 3 restructure; behavior unchanged.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeRequest, address, ApiResponse } from '../helpers.js';

export function registerMarketTools(server: McpServer): void {
  // Get Exchange Info
  server.tool('getInfo',
    "Retrieves exchange/market info for all tradable pairs. Returns a `{ success, data, error, code }` envelope; markets are returned oldest-first. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"BTC\", \"tick_size\": \"1\", \"min_tick\": \"0\", \"max_tick\": \"1000000\", \"lot_size\": \"0.00001\", \"max_leverage\": 50, \"isolated_only\": false, \"min_order_size\": \"10\", \"max_order_size\": \"5000000\", \"funding_rate\": \"0.0000125\", \"next_funding_rate\": \"0.0000125\", \"created_at\": 1748881333944 }], \"error\": null, \"code\": null }. Prices must be a multiple of tick_size (and within min_tick/max_tick); order sizes a multiple of lot_size; min_order_size/max_order_size are denominated in USD.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/info')
  );

  // Get Kline
  server.tool('getKline',
    "Retrieves candlestick (K-line) data for a trading pair and time interval. Example: { \"symbol\": \"BTC\", \"interval\": \"1m\", \"start_time\": 1742243160000 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"t\": 1748954160000, \"T\": 1748954220000, \"s\": \"BTC\", \"i\": \"1m\", \"o\": \"105376\", \"c\": \"105376\", \"h\": \"105376\", \"l\": \"105376\", \"v\": \"0.00022\", \"n\": 2 }], \"error\": null, \"code\": null }. Fields: t/T = candle start/end (ms), s = symbol, i = interval, o/c/h/l = open/close/high/low (decimal strings), v = volume, n = trade count.",
    {
      symbol: z.string()
        .describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      interval: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'])
        .describe("Candlestick interval. Valid values: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d"),
      start_time: z.number()
        .describe("Start time as a millisecond timestamp (integer). Required."),
      end_time: z.number().optional()
        .describe("End time as a millisecond timestamp (integer). Optional, defaults to current time if not provided.")
    },
    async ({ symbol, interval, start_time, end_time }) => makeRequest('GET', '/api/v1/kline', {
      symbol,
      interval,
      start_time,
      end_time
    })
  );

  // Get Recent Trades
  server.tool('getRecentTrades',
    "Retrieves recent trades for a specified trading pair. Example: { \"symbol\": \"BTC\" }. Returns a `{ success, data, error, code }` envelope plus a top-level last_order_id (an exchange-wide ordering nonce). Example response: { \"success\": true, \"data\": [{ \"event_type\": \"fulfill_taker\", \"price\": \"104721\", \"amount\": \"0.0001\", \"side\": \"close_long\", \"cause\": \"normal\", \"created_at\": 1765006315306 }], \"error\": null, \"code\": null, \"last_order_id\": 1557404170 }. side is open_long/open_short/close_long/close_short; cause is normal/market_liquidation/backstop_liquidation/settlement; created_at is a millisecond timestamp.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc.")
    },
    async ({ symbol }) => makeRequest('GET', '/api/v1/trades', { symbol })
  );

  // Get Current Time
  server.tool('getCurrentTime',
    "Gets the current server time in milliseconds since Unix epoch. Example response: { \"currentTime\": 1743611511078 }",
    {},
    async () => {
      const currentTime = Date.now();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ currentTime })
        }]
      };
    }
  );

  // Get Orderbook
  server.tool('getOrderbook',
    "Retrieves the current orderbook snapshot for a trading pair. Example: { \"symbol\": \"BTC\", \"agg_level\": 1 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": { \"s\": \"BTC\", \"l\": [[{ \"p\": \"104550\", \"a\": \"0.123\", \"n\": 3 }], [{ \"p\": \"104551\", \"a\": \"0.5\", \"n\": 1 }]], \"t\": 1716307842000 }, \"error\": null, \"code\": null }. data.l is [bids, asks]; each level has p (price), a (amount), n (order count); t is a millisecond timestamp. An empty market returns \"l\": [[], []].",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      agg_level: z.number().int().optional().describe("Price aggregation level (optional, defaults to 1)")
    },
    async ({ symbol, agg_level }) => makeRequest('GET', '/api/v1/book', { symbol, agg_level })
  );

  // Get Prices
  server.tool('getPrices',
    "Retrieves current price data (funding, mark, oracle, mid, etc.) for all trading pairs. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"BTC\", \"funding\": \"0.0000125\", \"next_funding\": \"0.0000125\", \"oracle\": \"105376\", \"mark\": \"105378.5\", \"mid\": \"105378\", \"yesterday_price\": \"104200\", \"open_interest\": \"1234.567\", \"volume_24h\": \"98765.432\", \"timestamp\": 1761177600000 }], \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/info/prices')
  );

  // Get Fees
  server.tool('getFees',
    "Retrieves fee tiers and their maker/taker fee rates. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"level\": 0, \"maker_fee_rate\": \"0.00015\", \"taker_fee_rate\": \"0.0004\" }], \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/info/fees')
  );

  // Get Mark Price Kline
  server.tool('getMarkPriceKline',
    "Retrieves mark-price candlestick (K-line) data for a trading pair and time interval. Example: { \"symbol\": \"BTC\", \"interval\": \"1m\", \"start_time\": 1742243160000 }. Returns a `{ success, data, error, code }` envelope with the same candle shape as getKline. volume is always '0' for mark price klines.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      interval: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'])
        .describe("Candlestick interval. Valid values: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d"),
      start_time: z.number().describe("Start time as a millisecond timestamp (integer). Required."),
      end_time: z.number().optional().describe("End time as a millisecond timestamp (integer). Optional."),
      limit: z.number().int().optional().describe("Maximum number of candles to return (optional).")
    },
    async ({ symbol, interval, start_time, end_time, limit }) => makeRequest('GET', '/api/v1/kline/mark', {
      symbol,
      interval,
      start_time,
      end_time,
      limit
    })
  );

  // Get Funding Rate History
  server.tool('getFundingRateHistory',
    "Retrieves funding rate history for a trading pair (cursor-paginated). Example: { \"symbol\": \"BTC\", \"limit\": 20 }. Returns a `{ success, data, error, code }` envelope plus next_cursor/has_more. Example response: { \"success\": true, \"data\": [{ \"oracle_price\": \"105376\", \"bid_impact_price\": \"105375.5\", \"ask_impact_price\": \"105376.5\", \"funding_rate\": \"0.0000125\", \"next_funding_rate\": \"0.0000125\", \"created_at\": 1761177600000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      limit: z.number().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ symbol, limit, cursor }) => makeRequest('GET', '/api/v1/funding_rate/history', { symbol, limit, cursor })
  );

  // Get Aggregated Funding Rates
  server.tool('getAggregatedFundingRates',
    "Retrieves aggregated funding rates across all exchanges. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"BTC\", \"rates\": { \"binance\": \"0.0001\", \"bybit\": \"0.00012\" } }], \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/funding_rate/aggregated')
  );

  // Get Loan Pool
  server.tool('getLoanPool',
    "Retrieves loan pool statistics (total borrowed, total borrowable, utilization, APR/APY). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": { \"total_borrowed\": \"1000000\", \"total_borrowable\": \"5000000\", \"utilization\": \"0.2\", \"borrow_apr\": \"0.05\", \"borrow_apy\": \"0.0513\", \"lend_apr\": \"0.04\", \"lend_apy\": \"0.0408\" }, \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/loan_pool')
  );

  // Get Sparklines
  server.tool('getSparklines',
    "Retrieves sparkline data (compact price charts) for one or more trading pairs. Example: { \"symbols\": \"BTC,ETH\", \"interval\": \"1h\" } (symbols optional; omit for all). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"s\": \"BTC\", \"d\": [{ \"t\": 1761177600000, \"c\": \"105376\" }] }], \"error\": null, \"code\": null }.",
    {
      symbols: z.string().optional().describe("Comma-separated symbols, e.g. 'BTC,ETH,SOL' (optional; omit for all)"),
      interval: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']).optional().describe("Candlestick interval (optional, default '1h')"),
      points: z.number().int().optional().describe("Number of data points to return (optional, default 16, max 168)")
    },
    async ({ symbols, interval, points }) => makeRequest('GET', '/api/v1/kline/sparklines', { symbols, interval, points })
  );

  // Get Position Liquidation Prices
  server.tool('getPositionLiquidationPrices',
    "Retrieves liquidation prices for the account's open positions. Example: { \"symbol\": \"BTC\" } (symbol optional; omit for all). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"BTC\", \"side\": \"bid\", \"amount\": \"0.5\", \"entry_price\": \"105000\", \"liquidation_price\": \"95000\" }], \"error\": null, \"code\": null }.",
    {
      symbol: z.string().optional().describe("Trading pair symbol, e.g., BTC, ETH, etc. (optional)"),
      is_isolated: z.boolean().optional().describe("Filter by isolated margin positions (optional)"),
      min_liq_price: z.number().optional().describe("Minimum liquidation price filter (optional)"),
      max_liq_price: z.number().optional().describe("Maximum liquidation price filter (optional)"),
      limit: z.number().int().optional().describe("Maximum number of positions to return (optional)")
    },
    async ({ symbol, is_isolated, min_liq_price, max_liq_price, limit }) =>
      makeRequest('GET', '/api/v1/position_liquidation_prices', {
        address, symbol, is_isolated, min_liq_price, max_liq_price, limit
      })
  );
}
