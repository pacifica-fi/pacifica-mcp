import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { z } from "zod";

// Create an MCP server
const server = new McpServer({
  name: 'Exchange API',
  version: '0.1.0'
});

// Base URL for the Exchange API
const BASE_URL = 'http://54.178.108.238:8080';

// Helper function to make API requests
const makeRequest = async (method, path, params, data) => {
  const url = `${BASE_URL}${path}`;
  const response = await axios({ method, url, params, data });
  return {
    content: [{type: "text", text: JSON.stringify(response.data)}]
  }
};

// Get Account Info
server.tool('getAccountInfo', 
  { 
    account: z.string()
  },
  async ({ account }) => makeRequest('GET', '/api/v1/account', { account })
);

// Update Leverage
server.tool('updateLeverage', 
  {
    user: z.string(),
    signature: z.string(),
    symbol: z.string(),
    leverage: z.number()
  },
  async (params) => makeRequest('POST', '/api/v1/account/leverage', null, params)
);

// Update Margin Mode
server.tool('updateMarginMode', 
  {
    user: z.string(),
    signature: z.string(),
    symbol: z.string(),
    is_isolated: z.boolean()
  },
  async (params) => makeRequest('POST', '/api/v1/account/margin', null, params)
);

// Get Account Settings
server.tool('getAccountSettings', 
  { 
    account: z.string()
  },
  async ({ account }) => makeRequest('GET', '/api/v1/account/settings', { account })
);

// Withdraw
server.tool('withdraw', 
  {
    user: z.string(),
    amount: z.number(),
    signature: z.string()
  },
  async (params) => makeRequest('POST', '/api/v1/account/withdraw', null, params)
);

// Bind Agent Wallet
server.tool('bindAgentWallet', 
  {
    user: z.string(),
    agent_wallet: z.string(),
    signature: z.string()
  },
  async (params) => makeRequest('POST', '/api/v1/agent/bind', null, params)
);

// Get Funding History
server.tool('getFundingHistory', 
  {
    account: z.string(),
    limit: z.number().optional(),
    offset: z.number().optional()
  },
  async (params) => makeRequest('GET', '/api/v1/funding/history', params)
);

// Get Exchange Info
server.tool('getInfo', 
  {},
  async () => makeRequest('GET', '/api/v1/info')
);

// Get Kline
server.tool('getKline', 
  {
    symbol: z.string(),
    interval: z.string(),
    startTime: z.number(),
    endTime: z.number().optional()
  },
  async (params) => makeRequest('GET', '/api/v1/kline', params)
);

// Cancel Stop Order
server.tool('cancelStopOrder', 
  {
    user: z.string(),
    signature: z.string(),
    symbol: z.string(),
    order_id: z.number()
  },
  async (params) => makeRequest('POST', '/api/v1/order/stop/cancel', null, params)
);

// Create Stop Order
server.tool('createStopOrder', 
  {
    user: z.string(),
    signature: z.string(),
    symbol: z.string(),
    stop_order: z.object({}),
    side: z.string(),
    reduce_only: z.boolean()
  },
  async (params) => makeRequest('POST', '/api/v1/order/stop/create', null, params)
);

// Get Open Orders
server.tool('getOpenOrders', 
  { 
    account: z.string()
  },
  async ({ account }) => makeRequest('GET', '/api/v1/orders', { account })
);

// Process Batch Orders
server.tool('processBatchOrders', 
  { 
    actions: z.array(z.any())
  },
  async (params) => makeRequest('POST', '/api/v1/orders/batch', null, params)
);

// Cancel Order
server.tool('cancelOrder', 
  {
    user: z.string(),
    signature: z.string(),
    symbol: z.string(),
    order_id: z.number(),
    tick_level: z.number(),
    side: z.string()
  },
  async (params) => makeRequest('POST', '/api/v1/orders/cancel', null, params)
);

// Cancel All Orders
server.tool('cancelAllOrders', 
  {
    user: z.string(),
    signature: z.string(),
    all_symbols: z.boolean()
  },
  async (params) => makeRequest('POST', '/api/v1/orders/cancel', null, params)
);

const transport = new StdioServerTransport();
await server.connect(transport);