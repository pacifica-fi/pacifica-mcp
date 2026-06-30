// src/tools/account.ts — account info, settings, and history tools.
// Moved verbatim from src/index.ts in the Tier 3 restructure; behavior unchanged.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeRequest, signRequest, address, ApiResponse } from '../helpers.js';

export function registerAccountTools(server: McpServer): void {
  // Get Account Info
  server.tool('getAccountInfo',
    "Retrieves high-level account information: balance, fee tier and rates, equity, margin usage, position/order counts, and per-asset spot balances. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": { \"balance\": \"2000.000000\", \"fee_level\": 0, \"maker_fee\": \"0.00015\", \"taker_fee\": \"0.0004\", \"account_equity\": \"2150.250000\", \"available_to_spend\": \"1800.750000\", \"available_to_withdraw\": \"1500.850000\", \"pending_balance\": \"0.000000\", \"pending_interest\": \"0.000000\", \"spot_collateral\": \"0.000000\", \"cross_account_equity\": \"2100.500000\", \"spot_market_value\": \"250.000000\", \"total_margin_used\": \"349.500000\", \"cross_mmr\": \"420.690000\", \"positions_count\": 2, \"orders_count\": 3, \"stop_orders_count\": 1, \"updated_at\": 1716200000000, \"spot_balances\": [{ \"symbol\": \"SOL\", \"amount\": \"1.50000000\", \"available_to_withdraw\": \"1.00000000\", \"pending_balance\": \"0.50000000\", \"daily_withdraw_amount_usd\": \"250.000000\", \"effective_daily_deposit_limit_usd\": \"50000.000000\", \"effective_daily_withdraw_limit_usd\": \"250000.000000\" }] }, \"error\": null, \"code\": null }. Monetary fields are decimal strings; cross_account_equity may be null; updated_at is a millisecond timestamp.",
    {},
    async ({}): Promise<any> => makeRequest('GET', '/api/v1/account', { account: address })
  );

  // Update Leverage
  server.tool('updateLeverage',
    "Updates the leverage multiplier for a specific trading pair (e.g. BTC, ETH). Each pair has a maximum leverage limit. Example: { \"symbol\": \"BTC\", \"leverage\": 10 } sets BTC to 10x. Returns { \"success\": true } on success, or { \"error\": \"Invalid leverage\", \"code\": 400 } on failure.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      leverage: z.number().describe("Leverage multiplier to set, must be within the maximum leverage allowed for the trading pair")
    },
    async ({ symbol, leverage }) => {
      const body = signRequest('update_leverage', { symbol, leverage });
      return makeRequest('POST', '/api/v1/account/leverage', body);
    }
  );

  // Update Margin Mode
  server.tool('updateMarginMode',
    "Switches between isolated and cross margin modes for a specific trading pair. Isolated mode limits risk to the position; cross mode uses the entire account balance as margin. Example: { \"symbol\": \"ETH\", \"is_isolated\": true } sets ETH to isolated margin. Returns { \"success\": true } on success, or { \"error\": \"Invalid margin mode\", \"code\": 400 } on failure.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      is_isolated: z.boolean().describe("true for isolated margin mode, false for cross margin mode")
    },
    async ({ symbol, is_isolated }) => {
      const body = signRequest('update_margin_mode', { symbol, is_isolated });
      return makeRequest('POST', '/api/v1/account/margin', body);
    }
  );

  // Get Account Settings
  server.tool('getAccountSettings',
    "Retrieves the account's non-default margin/leverage settings, auto-lend status, and per-asset spot settings. NOTE: markets at default settings (cross margin, max leverage) are omitted. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": { \"auto_lend_disabled\": null, \"margin_settings\": [{ \"symbol\": \"WLFI\", \"isolated\": false, \"leverage\": 5, \"created_at\": 1758085929703, \"updated_at\": 1758086074002 }], \"spot_settings\": [{ \"symbol\": \"SOL\", \"unified_margin_excluded\": false }] }, \"error\": null, \"code\": null }. auto_lend_disabled is null when at default (enabled); created_at/updated_at are millisecond timestamps.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/account/settings', { account: address })
  );

  // Withdraw
  server.tool('withdraw',
    "Withdraws funds from the perp account. Submit a signed request with the amount as a decimal string. Example: { \"amount\": \"100.50\" }. Returns { \"success\": true } on success.",
    {
      amount: z.string().describe("Amount of funds to withdraw, as a decimal string, e.g. \"100.50\"")
    },
    async ({ amount }) => {
      const body = signRequest('withdraw', { amount });
      return makeRequest('POST', '/api/v1/account/withdraw', body);
    }
  );

  // Bind Agent Wallet
  server.tool('bindAgentWallet',
    "Binds an agent wallet to the account via the legacy direct-bind endpoint (POST /api/v1/agent/bind). NOTE: the current recommended flow is to generate an agent (API) key on the Pacifica frontend or via the Python SDK and pass it as `agent_wallet` in the request header on each signed request, rather than binding here. Example: { \"agent_wallet\": \"AgentWalletPubkey...\" }. Returns { \"success\": true } on success.",
    {
      agent_wallet: z.string().describe("Agent wallet address to bind to the account")
    },
    async ({ agent_wallet }) => {
      const body = signRequest('bind_agent_wallet', { agent_wallet });
      return makeRequest('POST', '/api/v1/agent/bind', body);
    }
  );

  // Get Funding History
  server.tool('getFundingHistory',
    "Retrieves funding-payment history (cursor-paginated). Each record is a funding payment/receipt on a perpetual position. Example: { \"limit\": 20, \"cursor\": \"11115hVka\" }. Example response: { \"success\": true, \"data\": [{ \"history_id\": 2287920, \"symbol\": \"PUMP\", \"side\": \"ask\", \"amount\": \"39033804\", \"payout\": \"2.617479\", \"rate\": \"0.0000125\", \"created_at\": 1759222804122 }], \"next_cursor\": \"11114Lz77\", \"has_more\": true }. side is the position side that produced the payment (bid=long/ask=short); amount is token-denominated; payout is in USD; created_at is a millisecond timestamp. Page using next_cursor while has_more is true.",
    {
      limit: z.number().optional().describe("Maximum number of records to return (optional, defaults to system-defined limit)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional). Offset pagination was deprecated 2025-10-30.")
    },
    async ({ limit, cursor }) => makeRequest('GET', '/api/v1/funding/history', { account: address, limit, cursor })
  );

  // Get Portfolio History
  server.tool('getPortfolioHistory',
    "Retrieves account equity and PnL history over a time range. time_range is REQUIRED. Example: { \"time_range\": \"7d\" } for the last 7 days. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"account_equity\": \"61046.308885\", \"pnl\": \"9297.553505\", \"timestamp\": 1761177600000 }], \"error\": null, \"code\": null }. account_equity = balance + unrealized PnL; pnl is the account's PnL since creation; timestamp is a millisecond timestamp. Returns an empty data array if the account has no history.",
    {
      time_range: z.enum(['1d', '7d', '14d', '30d', 'all']).describe("Required. Time window for the portfolio history. One of: 1d, 7d, 14d, 30d, all."),
      start_time: z.number().optional().describe("Start time in milliseconds (optional)"),
      end_time: z.number().optional().describe("End time in milliseconds (optional)"),
      limit: z.number().int().optional().describe("Maximum number of data points to return (optional, defaults to 100)")
    },
    async ({ time_range, start_time, end_time, limit }) => {
      return makeRequest('GET', '/api/v1/portfolio', {
        account: address,
        time_range,
        start_time,
        end_time,
        limit
      });
    }
  );

  // Get Balance History
  server.tool('getBalanceHistory',
    "Retrieves the account's balance-change history (cursor-paginated). By default shows deposit, withdraw, subaccount transfer, and payout events; set include_trades to true to include trade events. Example: { \"limit\": 20 }. Example response: { \"success\": true, \"data\": [{ \"amount\": \"100.000000\", \"balance\": \"2100.000000\", \"pending_balance\": \"0.000000\", \"event_type\": \"deposit\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)"),
      include_trades: z.boolean().optional().describe("Include trade events in results (optional, default false)")
    },
    async ({ limit, cursor, include_trades }) =>
      makeRequest('GET', '/api/v1/account/balance/history', { account: address, limit, cursor, include_trades })
  );

  // Get Account Loan Info
  server.tool('getAccountLoanInfo',
    "Retrieves the account's loan information including borrowed amounts, pending interest, collateral utilization, and spot balances. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": { \"borrowed\": \"0.000000\", \"pending_interest\": \"0.000000\", \"collateral_utilization\": \"0.0\", \"total_interest_earned\": \"0.000000\", \"total_interest_paid\": \"0.000000\", \"spot_balances\": [] }, \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/account/loan', { account: address })
  );

  // Get Daily Account Activity
  server.tool('getDailyAccountActivity',
    "Retrieves the account's daily activity summary (points, fees, volume) for a time range. Example: { \"start_time\": 1761000000000, \"end_time\": 1761177600000 } (BOTH REQUIRED in milliseconds). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"date\": \"2026-01-15\", \"points\": \"100\", \"fees_paid\": \"5.25\", \"volume\": \"10000.00\" }], \"error\": null, \"code\": null }. NOTE: On mainnet this endpoint is restricted to frontend origins and may return 403; it is unrestricted on testnet.",
    {
      start_time: z.number().describe("Start time as a millisecond timestamp (REQUIRED)"),
      end_time: z.number().describe("End time as a millisecond timestamp (REQUIRED)")
    },
    async ({ start_time, end_time }) =>
      makeRequest('GET', '/api/v1/account/activity/daily', { account: address, start_time, end_time })
  );

  // Get Payout History
  server.tool('getPayoutHistory',
    "Retrieves the account's payout history (cursor-paginated). Example: { \"limit\": 20 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"amount\": \"100.00\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) =>
      makeRequest('GET', '/api/v1/account/payout/history', { account: address, limit, cursor })
  );

  // Get Deposit History
  server.tool('getDepositHistory',
    "Retrieves the account's deposit history (cursor-paginated). Example: { \"limit\": 20 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"amount\": \"100.00\", \"transaction_id\": \"abc123...\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) =>
      makeRequest('GET', '/api/v1/account/deposit/history', { account: address, limit, cursor })
  );

  // Get Withdrawal History
  server.tool('getWithdrawalHistory',
    "Retrieves the account's withdrawal history (cursor-paginated). Example: { \"limit\": 20 }. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"amount\": \"100.00\", \"batch_nonce\": \"12345\", \"transaction_id\": \"abc123...\", \"created_at\": 1716200000000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true }. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) =>
      makeRequest('GET', '/api/v1/account/withdraw/history', { account: address, limit, cursor })
  );

  // Get Pending Withdrawals
  server.tool('getPendingWithdrawals',
    "Retrieves the account's pending withdrawals (not yet batched). Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"amount\": \"100.00\", \"batch_nonce\": \"12345\", \"created_at\": 1716200000000 }], \"error\": null, \"code\": null }.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/account/withdraw/pending', { account: address })
  );

  // Set Auto-Lend Disabled
  server.tool('setAutoLendDisabled',
    "Sets the auto-lend preference for spot collateral. true = disable auto-lending, false = enable, OMIT to clear back to the default. Example: { \"disabled\": true }. Returns { \"success\": true } on success. The signed message uses the omit-field variant when disabled is undefined (signRequest drops undefined keys from both the signed message and wire body).",
    {
      disabled: z.boolean().optional().describe("true to disable auto-lending, false to enable, OMIT to clear back to default")
    },
    async ({ disabled }) => {
      const body = signRequest('set_auto_lend_disabled', { disabled });
      return makeRequest('POST', '/api/v1/account/settings/auto_lend_disabled', body);
    }
  );

  // Update Spot Settings
  server.tool('updateSpotSettings',
    "Updates per-asset spot margin settings. Sets whether a spot asset is excluded from unified margin collateral. Example: { \"symbol\": \"SOL\", \"unified_margin_excluded\": true }. Returns { \"success\": true } on success. Use getAccountSettings to inspect the current spot_settings array.",
    {
      symbol: z.string().describe("Spot asset symbol, e.g., SOL, BTC, ETH"),
      unified_margin_excluded: z.boolean().describe("true to exclude the asset from unified margin collateral, false to include it")
    },
    async ({ symbol, unified_margin_excluded }) => {
      const body = signRequest('update_account_spot_settings', { symbol, unified_margin_excluded });
      return makeRequest('POST', '/api/v1/account/settings/spot', body);
    }
  );
}
