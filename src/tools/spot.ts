// src/tools/spot.ts — spot asset tools (read-only data).
// Created in Phase 2 of Tier 3 expansion; deferred from Phase 1 (OE-001).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeRequest, signRequest, address, ApiResponse } from '../helpers.js';

export function registerSpotTools(server: McpServer): void {
  // Get Spot Assets
  server.tool('getSpotAssets',
    "Retrieves the list of available spot assets. Example: { \"include_inactive\": false, \"collateral_enabled_only\": false } (both optional). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"SOL\", \"tick_size\": \"0.01\", \"lot_size\": \"0.0001\", \"active\": true, \"collateral_enabled\": true, \"ltv_ratio\": \"0.8\", \"created_at\": 1748881333944, \"updated_at\": 1748881333944 }], \"error\": null, \"code\": null }.",
    {
      include_inactive: z.boolean().optional().describe("Include inactive assets (optional, default false)"),
      collateral_enabled_only: z.boolean().optional().describe("Only return assets enabled as collateral (optional, default false)")
    },
    async ({ include_inactive, collateral_enabled_only }) =>
      makeRequest('GET', '/api/v1/spot_assets', { include_inactive, collateral_enabled_only })
  );

  // Get Bridge Info
  server.tool('getBridgeInfo',
    "Retrieves bridge parameters for all spot assets. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"SOL\", \"minimum_deposit\": \"0.1\", \"withdrawal_fee\": \"0.01\", \"bridge_program\": \"pCfa...\", \"mint\": null, \"decimals\": 9 }], \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/spot_assets/bridge/info')
  );

  // Get Bridge Parameters (single asset)
  server.tool('getBridgeParameters',
    "Retrieves bridge parameters for a single spot asset by symbol (path parameter). Example: { \"symbol\": \"SOL\" }. Example response: { \"success\": true, \"data\": { \"symbol\": \"SOL\", \"minimum_deposit\": \"0.1\", \"withdrawal_fee\": \"0.01\", \"bridge_program\": \"pCfa...\", \"mint\": null, \"decimals\": 9 }, \"error\": null, \"code\": null }.",
    {
      symbol: z.string().describe("Spot asset symbol, e.g., SOL, BTC, ETH")
    },
    async ({ symbol }) =>
      makeRequest('GET', `/api/v1/spot_assets/bridge/parameters/${encodeURIComponent(symbol)}`)
  );

  // Get Spot Deposit History
  server.tool('getSpotDepositHistory',
    "Retrieves the account's spot asset deposit history (cursor-paginated). Example: { \"limit\": 20 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"SOL\", \"amount\": \"1.5\", \"transaction_id\": \"abc123...\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) =>
      makeRequest('GET', '/api/v1/account/spot_asset/deposit/history', { account: address, limit, cursor })
  );

  // Get Spot Withdrawal History
  server.tool('getSpotWithdrawalHistory',
    "Retrieves the account's spot asset withdrawal history (cursor-paginated). Example: { \"limit\": 20 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"SOL\", \"amount\": \"1.5\", \"batch_nonce\": \"12345\", \"transaction_id\": \"abc123...\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) =>
      makeRequest('GET', '/api/v1/account/spot_asset/withdraw/history', { account: address, limit, cursor })
  );

  // Get Pending Spot Withdrawals
  server.tool('getPendingSpotWithdrawals',
    "Retrieves the account's pending spot asset withdrawals (not yet batched). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"SOL\", \"amount\": \"1.5\", \"amount_requested\": \"1.5\", \"fee_amount\": \"0.01\", \"batch_nonce\": \"12345\", \"created_at\": 1716200000000 }], \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/account/spot_asset/withdraw/pending', { account: address })
  );

  // Get Spot Balance History
  server.tool('getSpotBalanceHistory',
    "Retrieves the account's spot asset balance history (cursor-paginated). Example: { \"symbol\": \"SOL\", \"limit\": 20 } (symbol optional; omit for all assets). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"symbol\": \"SOL\", \"amount\": \"1.5\", \"balance\": \"2.5\", \"event_type\": \"deposit\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      symbol: z.string().optional().describe("Spot asset symbol, e.g., SOL, BTC, ETH (optional; omit for all assets)"),
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ symbol, limit, cursor }) =>
      makeRequest('GET', '/api/v1/account/spot_balance/history', { account: address, symbol, limit, cursor })
  );

  // Withdraw Spot Asset
  server.tool('withdrawSpotAsset',
    "Queues a spot asset withdrawal to the wallet's external address (on-chain transfer, not reversible). Example: { \"symbol\": \"SOL\", \"amount\": \"1.5\" } or { \"symbol\": \"SOL\", \"amount\": \"1.5\", \"idempotency_key\": \"uuid-here\" } to deduplicate. Returns { \"symbol\", \"batch_nonce\", \"requested_amount\", \"fee_amount\" }. The withdrawal is queued -- check getPendingSpotWithdrawals to verify it is pending. NOTE: a spot withdrawal is an on-chain transfer and cannot be reversed by the API.",
    {
      symbol: z.string().describe("Spot asset symbol to withdraw, e.g., SOL, BTC, ETH"),
      amount: z.string().describe("Amount to withdraw as a decimal string, e.g. '1.5'"),
      idempotency_key: z.string().uuid().optional().describe("Optional UUID to deduplicate the request")
    },
    async ({ symbol, amount, idempotency_key }) => {
      const body = signRequest('withdraw_spot_asset', { symbol, amount, idempotency_key });
      return makeRequest('POST', '/api/v1/account/spot_asset/withdraw', body);
    }
  );
}
