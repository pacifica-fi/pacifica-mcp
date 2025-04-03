#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { z } from "zod";
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { userInfo } from 'os';

// Create an MCP server
const server = new McpServer({
  name: 'Pacifica Exchange API',
  version: '0.0.1'
});

const BASE_URL: string = 'https://test-api.pacifica.fi';

let privateKey: string | undefined = process.env.PRIVATE_KEY;
let address: string | undefined = process.env.ADDRESS;

// Define response type
interface ApiResponse {
  content: Array<{
    type: "text";
    text: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// Helper function to make API requests
const makeRequest = async (
  method: string, 
  path: string, 
  params?: Record<string, any>, 
): Promise<ApiResponse> => {
  const url: string = `${BASE_URL}${path}`;
  const config: AxiosRequestConfig = { method, url, params };
  const response: AxiosResponse = await axios(config);
  return {
    content: [{
      type: "text",
      text: JSON.stringify(response.data)
    }]
  };
};

const signMessage = (message: string): string => {
  if (!privateKey) throw new Error('Private key not set');
  const messageBytes: Uint8Array = new Uint8Array(Buffer.from(message));
  const secretKey: Uint8Array = bs58.decode(privateKey);
  const signature: Uint8Array = nacl.sign.detached(messageBytes, secretKey);
  return bs58.encode(signature);
};

// Get Account Info
server.tool('getAccountInfo', 
  "Retrieves user account information, including current balance and fee level. Returns the account balance and current fee tier. Example response: { \"balance\": \"2000.000000\", \"feeLevel\": 0 }",
  {},
  async ({}): Promise<any> => makeRequest('GET', '/api/v1/account', { account: address })
);

// Update Leverage
server.tool('updateLeverage', 
  "Updates the leverage multiplier for a specific trading pair. Allows users to change leverage for specific trading pairs (such as BTC, ETH, etc.), affecting the size of positions that can be opened. Each trading pair has a maximum leverage limit. Example: To set BTC leverage to 10x, use { \"symbol\": \"BTC\", \"leverage\": 10 }",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    leverage: z.number().describe("Leverage multiplier to set, must be within the maximum leverage allowed for the trading pair")
  },
  async ({ symbol, leverage }) => {
    const messageToSign = `${symbol.toUpperCase()},${leverage}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/account/leverage', { 
      user: address, 
      symbol, 
      leverage, 
      signature 
    });
  }
);

// Update Margin Mode
server.tool('updateMarginMode', 
  "Switches between isolated and cross margin modes for a specific trading pair. Isolated mode limits risk to the position, while cross mode uses the entire account balance as margin. Example: To set ETH to isolated margin, use { \"symbol\": \"ETH\", \"is_isolated\": true }",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    is_isolated: z.boolean().describe("true for isolated margin mode, false for cross margin mode")
  },
  async ({ symbol, is_isolated }) => {
    const messageToSign = `${symbol.toUpperCase()},${is_isolated}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/account/margin', { 
      user: address, 
      symbol, 
      is_isolated, 
      signature
    });
  }
);

// Get Account Settings
server.tool('getAccountSettings', 
  "Retrieves user account settings, including leverage multipliers and margin modes for various trading pairs. Example response: [{ \"createdAt\": \"2025-03-25T16:00:37.600487Z\", \"isolated\": true, \"leverage\": 30, \"symbol\": \"ETH\", \"updatedAt\": \"2025-03-25T16:00:38.280350Z\" }]",
  {},
  async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/account/settings', { account: address })
);

// Withdraw
server.tool('withdraw', 
  "Withdraws funds from the exchange account. Users can specify the withdrawal amount and submit a signed request. Example: To withdraw 100 units, use { \"amount\": 100 }",
  {
    amount: z.number().describe("Amount of funds to withdraw")
  },
  async ({ amount }) => {
    const messageToSign = `${amount}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/account/withdraw', { 
      user: address, 
      amount, 
      signature
    });
  }
);

// Bind Agent Wallet
server.tool('bindAgentWallet', 
  "Binds an agent wallet address to the user's account. Allows users to associate a proxy wallet with their account for automated trading or delegated operations. Example: { \"agent_wallet\": \"AgentWalletAddress123\" }",
  {
    agent_wallet: z.string().describe("Agent wallet address to bind to the account")
  },
  async ({ agent_wallet }) => {
    const messageToSign = `${agent_wallet}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/agent/bind', { 
      user: address, 
      agent_wallet, 
      signature
    });
  }
);

// Get Funding History
server.tool('getFundingHistory', 
  "Retrieves funding rate history records. Returns the history of funding rate payments and receipts in perpetual contracts. Example usage: { \"limit\": 10, \"offset\": 0 } to get the first 10 funding records. Example response: [{ \"amount\": \"0.0067\", \"createdAt\": \"2025-03-25T16:00:06.600783Z\", \"historyId\": 12551, \"payout\": \"-0.007351166970000000000000000\", \"rate\": \"0.0000125000000000000000000000\", \"side\": \"bid\", \"symbol\": \"BTC\" }]",
  {
    limit: z.number().optional().describe("Maximum number of records to return (optional, defaults to system-defined limit)"),
    offset: z.number().optional().describe("Number of records to skip (optional, defaults to 0)")
  },
  async ({ limit, offset }) => makeRequest('GET', '/api/v1/funding/history', { account: address, limit, offset })
);

// Get Exchange Info
server.tool('getInfo', 
  "Retrieves exchange information, including detailed information for all tradable pairs. Example response: [{ \"fundingRate\": \"0.0000125000000000000000000000\", \"isolatedOnly\": false, \"maxLeverage\": 50, \"maxOrderSize\": \"1000000\", \"minOrderSize\": \"10\", \"symbol\": \"BTC\", \"tickSize\": \"0.1\" }]",
  {},
  async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/info')
);

// Get Kline
server.tool('getKline', 
  "Retrieves candlestick (K-line) data for a specific trading pair and time interval. Example: { \"symbol\": \"BTC\", \"interval\": \"1h\", \"startTime\": \"1625097600000\" } for hourly BTC candlesticks. Example response: [{ \"T\": 1742243220000, \"c\": \"84072\", \"h\": \"84108\", \"i\": \"1h\", \"l\": \"84072\", \"n\": 58, \"o\": \"84108\", \"s\": \"BTC\", \"t\": 1742243160000, \"v\": \"0.1944\" }]",
  {
    symbol: z.string()
      .describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    interval: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
      .describe("Candlestick interval. Valid values: 1m (1 minute), 5m, 15m, 30m, 1h (1 hour), 4h, 1d (1 day)"),
    startTime: z.string()
      .describe("Start time in milliseconds. Required."),
    endTime: z.string().optional()
      .describe("End time in milliseconds. Optional, defaults to current time if not provided.")
      .nullable()
  },
  async ({ symbol, interval, startTime, endTime }) => makeRequest('GET', '/api/v1/kline', { 
    symbol, 
    interval, 
    startTime, 
    endTime 
  })
);

// Cancel Stop Order
server.tool('cancelStopOrder', 
  "Cancels an existing stop loss/take profit order. Example: { \"symbol\": \"BTC\", \"order_id\": 12345 } to cancel stop order with ID 12345 for BTC.",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    order_id: z.number().describe("ID of the stop loss/take profit order to cancel")
  },
  async ({ symbol, order_id }) => {
    const messageToSign = `${symbol.toUpperCase()},${order_id}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/orders/stop/cancel', { 
      user: address, 
      symbol, 
      order_id, 
      signature 
    });
  }
);

// Create Stop Order
server.tool('createStopOrder', 
  "Creates stop loss/take profit orders. These orders are automatically executed when the price reaches preset conditions, useful for limiting losses or securing profits. Example: { \"symbol\": \"BTC\", \"stop_order\": { \"stop_tick_level\": 85000, \"limit_tick_level\": 84800, \"amount\": \"0.01\" }, \"side\": \"bid\", \"reduce_only\": true } to create a stop order that triggers at price level 85000 with a limit price of 84800 for 0.01 BTC.",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    stop_order: z.object({
      stop_tick_level: z.number().int().min(0).describe("The price level at which the stop order will be triggered"),
      limit_tick_level: z.number().int().min(0).optional().describe("Optional limit price level for the order after it's triggered. If not provided, a market order will be created"),
      amount: z.string().optional().describe("The amount to trade. If not provided, the entire position will be used")
    }).describe("Stop loss/take profit order parameters, including trigger price and execution conditions"),
    side: z.string().describe("Order direction, such as 'bid' (buy) or 'ask' (sell)"),
    reduce_only: z.boolean().describe("Whether to reduce position only; when set to true, this order can only reduce positions, not increase them")
  },
  async ({ symbol, stop_order, side, reduce_only }) => {
    const messageToSign = `${symbol.toUpperCase()},${side},${reduce_only},${stop_order}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/order/stop/create', { 
      symbol, 
      stop_order, 
      side, 
      reduce_only, 
      signature,
      user: address 
    });
  }
);

// Get Open Orders
server.tool('getOpenOrders', 
  "Retrieves all unfilled orders for the current account. Example response: [{ \"createdAt\": \"2025-03-25T15:13:44.820568Z\", \"initialAmount\": \"0.0053\", \"orderId\": 13753364, \"orderType\": \"limit\", \"reduceOnly\": false, \"remainingAmount\": \"0.0053\", \"side\": \"bid\", \"symbol\": \"BTC\", \"tickLevel\": 86500 }]",
  {},
  async () => {
    return makeRequest('GET', '/api/v1/orders', { account: address });
  }
);

// Open Order
server.tool('openOrder', 
  "Creates a new trading order. Example: { \"symbol\": \"BTC\", \"tick_level\": 87000, \"amount\": \"0.01\", \"side\": \"bid\", \"tif\": \"GTC\", \"reduce_only\": false } to place a buy limit order for 0.01 BTC at price level 87000.",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    tick_level: z.number().describe("Price tick level, representing the order price"),
    amount: z.string()
      .describe("Trade quantity, represented as a string to maintain precision. This represents the quantity of the base currency in the trading pair (e.g., BTC in BTC/USD). To trade a specific USD amount, you need to convert it to the equivalent base currency amount using the current market price."),
    side: z.enum(['bid', 'ask']).describe("Order direction: 'bid' (buy) or 'ask' (sell)"),
    tif: z.enum(['GTC', 'IOC', 'ALO']).describe("Time-in-force parameter: GTC (Good Till Cancel), IOC (Immediate or Cancel), ALO (Add Limit Only)"),
    reduce_only: z.boolean().describe("Whether to reduce position only; when set to true, this order can only reduce positions, not increase them")
  },
  async ({ symbol, tick_level, amount, side, tif, reduce_only }) => {
    const messageToSign = `${symbol.toUpperCase()},${tick_level},${amount},${side},${tif},${reduce_only}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/orders/create', {
      user: address,
      symbol,
      tick_level,
      amount,
      side,
      tif,
      reduce_only,
      signature
    });
  }
);

// Cancel Order
server.tool('cancelOrder', 
  "Cancels a specified unfilled order. Example: { \"symbol\": \"BTC\", \"order_id\": 13753364, \"tick_level\": 86500, \"side\": \"bid\" } to cancel a specific BTC buy order.",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    order_id: z.number().describe("ID of the order to cancel"),
    tick_level: z.number().describe("Price tick level, representing the order price"),
    side: z.enum(['bid', 'ask']).describe("Order direction: 'bid' (buy) or 'ask' (sell)")
  },
  async ({ symbol, order_id, tick_level, side }) => {
    const messageToSign = `${symbol.toUpperCase()},${order_id},${tick_level},${side}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/orders/cancel', { 
      user: address, 
      symbol, 
      order_id, 
      tick_level, 
      side, 
      signature 
    });
  }
);

// Cancel All Orders
server.tool('cancelAllOrders', 
  "Cancels all unfilled orders or all unfilled orders for a specified trading pair. Example: { \"symbol\": \"BTC\", \"all_symbols\": false } to cancel all BTC orders, or { \"symbol\": \"BTC\", \"all_symbols\": true } to cancel all orders for all trading pairs.",
  {
    symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
    all_symbols: z.boolean().describe("Whether to cancel orders for all trading pairs. true to cancel orders for all trading pairs, false to cancel only for the specified symbol")
  },
  async ({ symbol, all_symbols }) => {
    const messageToSign = `${symbol.toUpperCase()},${all_symbols}`;
    const signature = signMessage(messageToSign);
    return makeRequest('POST', '/api/v1/orders/cancel_all', { 
      user: address, 
      symbol, 
      all_symbols, 
      signature 
    });
  }
);

// Get Order History By Id
server.tool('getOrderHistoryById', 
  "Retrieves the history of a specific order by its ID. Example: { \"order_id\": 13753364 } to get the history of order 13753364. Example response: [{ \"amount\": \"0.1\", \"createdAt\": \"2025-03-26T18:05:41.152521Z\", \"eventType\": \"fulfill_limit\", \"historyId\": 2, \"orderId\": 13753364, \"price\": \"50000.00\" }]",
  {
    order_id: z.number().int().min(0).describe("ID of the order to query history for"),
    limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
    offset: z.number().int().optional().describe("Number of records to skip (optional)")
  },
  async ({ order_id, limit, offset }) => makeRequest('GET', '/api/v1/orders/history', { order_id, limit, offset })
);

// Get Portfolio History
server.tool('getPortfolioHistory', 
  "Retrieves account portfolio history data. Example: { \"limit\": 10, \"granularity_in_minutes\": 60 } to get hourly portfolio data for the last 10 data points. Example response: [{ \"account_equity\": \"997.88760080\", \"timestamp\": \"2025-03-26T16:42:00Z\" }]",
  {
    limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
    offset: z.number().int().optional().describe("Number of records to skip (optional)"),
    start_time: z.number().optional().describe("Start time in milliseconds (optional)"),
    end_time: z.number().optional().describe("End time in milliseconds (optional)"),
    granularity_in_minutes: z.number().optional().describe("Time granularity in minutes (optional)")
  },
  async ({ limit, offset, start_time, end_time, granularity_in_minutes }) => {
    return makeRequest('GET', '/api/v1/portfolio', { 
      account: address,
      limit, 
      offset, 
      start_time, 
      end_time, 
      granularity_in_minutes 
    });
  }
);

// Get Current Positions
server.tool('getCurrentPositions', 
  "Retrieves information on all currently held positions. Example response: [{ \"amount\": \"0.0067\", \"createdAt\": \"2025-03-18T20:01:26.983080Z\", \"entryPrice\": \"82124.29850746268656716417911\", \"isolated\": false, \"margin\": \"-0.2483864\", \"side\": \"bid\", \"symbol\": \"BTC\" }]",
  {},
  async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/positions', { account: address })
);

// Get Position History
server.tool('getPositionHistory', 
  "Retrieves historical position change records. Example: { \"symbol\": \"BTC\", \"limit\": 10 } to get the last 10 BTC position changes. Example response: [{ \"amount\": \"0.0011\", \"createdAt\": \"2025-03-21T09:12:12.652363Z\", \"entryPrice\": \"82124.29\", \"eventType\": \"open_long\", \"fee\": \"0.017820\", \"pnl\": \"-0.017820\" }]",
  {
    symbol: z.string().optional().describe("Trading pair to filter by (optional)"),
    limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
    offset: z.number().int().optional().describe("Number of records to skip (optional)"),
    start_time: z.number().optional().describe("Start time in milliseconds (optional)"),
    end_time: z.number().optional().describe("End time in milliseconds (optional)")
  },
  async ({ symbol, limit, offset, start_time, end_time }) => {
    return makeRequest('GET', '/api/v1/positions/history', { 
      account: address,
      symbol, 
      limit, 
      offset, 
      start_time, 
      end_time 
    });
  }
);

// Get Recent Trades
server.tool('getRecentTrades', 
  "Retrieves recent transaction records for a specified trading pair. Example: { \"symbol\": \"BTC\" } to get recent BTC trades. Example response: [{ \"price\": \"84050\", \"quantity\": \"0.01\", \"side\": \"buy\", \"timestamp\": \"2025-03-26T16:42:00Z\" }]",
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

const transport = new StdioServerTransport();
await server.connect(transport);