// src/tools/orders.ts — order management and position tools.
// Moved verbatim from src/index.ts in the Tier 3 restructure; behavior unchanged.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeRequest, signRequest, address, ApiResponse } from '../helpers.js';

// Nested StopOrderInfo config shared by openOrder's take_profit / stop_loss
// fields and createStopOrder's stop_order field. Mirrors the backend
// StopOrderInfo struct (perp-backend api/src/client/types/mod.rs:36-57): the REST
// inputs are decimal-string prices; the server derives stop_tick_level /
// limit_tick_level from them via book.get_tick().
export const stopOrderInfoSchema = z.object({
  stop_price: z.string().describe("Trigger price as a decimal string, e.g. '64000.5'"),
  limit_price: z.string().optional().describe("Optional limit price (decimal string); omit for a market-style stop"),
  amount: z.string().optional().describe("Optional amount (decimal string); defaults to the parent order / full position size"),
  client_order_id: z.string().uuid().optional().describe("Optional client-supplied UUID for this stop leg"),
  trigger_price_type: z.enum(['mark_price', 'last_trade_price', 'mid_price']).optional()
    .describe("Which price triggers the stop. CAUTION: despite backend docs claiming mark_price, omitting this empirically defaults to mid_price (the API forwards None and the engine treats None as book mid) — on an empty book mid is 0, which makes any stop-loss invalid; pass 'mark_price' explicitly"),
});

export function registerOrderTools(server: McpServer): void {
  // Get Open Orders
  server.tool('getOpenOrders',
    "Retrieves all open (unfilled) orders for the current account. Returns a `{ success, data, error, code }` envelope plus a top-level last_order_id (an exchange-wide ordering nonce). Example response: { \"success\": true, \"data\": [{ \"order_id\": 315979358, \"client_order_id\": \"add9a4b5-c7f7-4124-b57f-86982d86d479\", \"symbol\": \"ASTER\", \"side\": \"ask\", \"price\": \"1.836\", \"initial_amount\": \"85.33\", \"filled_amount\": \"0\", \"cancelled_amount\": \"0\", \"stop_price\": null, \"order_type\": \"limit\", \"stop_parent_order_id\": null, \"reduce_only\": false, \"created_at\": 1759224706737, \"updated_at\": 1759224706737 }], \"error\": null, \"code\": null, \"last_order_id\": 1557370337 }. order_type is one of limit, market, stop_limit, stop_market, take_profit_limit, stop_loss_limit, take_profit_market, stop_loss_market; amounts are token-denominated decimal strings; created_at/updated_at are millisecond timestamps.",
    {},
    async () => {
      return makeRequest('GET', '/api/v1/orders', { account: address });
    }
  );

  // Open Order
  server.tool('openOrder',
    "Creates a new limit order, optionally with an attached take-profit and/or stop-loss. Price and amount are decimal strings. Example: { \"symbol\": \"BTC\", \"price\": \"65000.5\", \"amount\": \"0.001\", \"side\": \"bid\", \"tif\": \"GTC\", \"reduce_only\": false }. Returns { \"order_id\": 12345 } on success, or { \"error\": \"Invalid order parameters\", \"code\": 400 } on failure. Note: GTC and IOC orders are subject to a ~200ms delay to protect liquidity providers.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      price: z.string().describe("Order price as a decimal string (preserves precision), e.g. '65000.5'"),
      amount: z.string().describe("Order quantity as a decimal string (preserves precision), e.g. '0.001'"),
      side: z.enum(['bid', 'ask']).describe("Order direction: 'bid' (buy) or 'ask' (sell)"),
      tif: z.enum(['GTC', 'IOC', 'ALO', 'TOB', 'RFQ']).describe("Time-in-force: GTC (Good Till Cancel), IOC (Immediate or Cancel), ALO (Add Limit Only / post-only), TOB (Top of Book), RFQ (Request for Quote)"),
      reduce_only: z.boolean().describe("Whether the order may only reduce an existing position"),
      client_order_id: z.string().uuid().optional().describe("Optional client-supplied UUID to track the order"),
      take_profit: stopOrderInfoSchema.optional().describe("Optional take-profit stop order attached to this order"),
      stop_loss: stopOrderInfoSchema.optional().describe("Optional stop-loss stop order attached to this order"),
      builder_code: z.string().optional().describe("Optional builder code (3-16 alphanumeric characters)"),
    },
    async ({ symbol, price, amount, side, tif, reduce_only, client_order_id, take_profit, stop_loss, builder_code }) => {
      const body = signRequest('create_order', {
        symbol, price, amount, side, tif, reduce_only,
        client_order_id, take_profit, stop_loss, builder_code,
      });
      return makeRequest('POST', '/api/v1/orders/create', body);
    }
  );

  // Cancel Order
  server.tool('cancelOrder',
    "Cancels a specified unfilled order by symbol and order ID. Example: { \"symbol\": \"BTC\", \"order_id\": 13753364 }. Returns { \"success\": true } on success, or { \"error\": \"Order not found\", \"code\": 400 } on failure.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      order_id: z.number().describe("ID of the order to cancel")
    },
    async ({ symbol, order_id }) => {
      const body = signRequest('cancel_order', { symbol, order_id });
      return makeRequest('POST', '/api/v1/orders/cancel', body);
    }
  );

  // Cancel All Orders
  server.tool('cancelAllOrders',
    "Cancels all unfilled orders, or all unfilled orders for a specified trading pair. Example: { \"symbol\": \"BTC\", \"all_symbols\": false, \"exclude_reduce_only\": false } cancels all BTC orders; { \"all_symbols\": true, \"exclude_reduce_only\": false } cancels across all pairs. Returns { \"cancelled_count\": 5 } on success, or { \"error\": \"Invalid parameters\", \"code\": 400 } on failure.",
    {
      symbol: z.string().optional().describe("Trading pair symbol, e.g., BTC, ETH. Required only when all_symbols is false; omit when all_symbols is true."),
      all_symbols: z.boolean().describe("Whether to cancel orders for all trading pairs. true to cancel across all pairs, false to cancel only for the specified symbol"),
      exclude_reduce_only: z.boolean().describe("Whether to exclude reduce-only orders from cancellation. Required by the API.")
    },
    async ({ symbol, all_symbols, exclude_reduce_only }) => {
      const body = signRequest('cancel_all_orders', { symbol, all_symbols, exclude_reduce_only });
      return makeRequest('POST', '/api/v1/orders/cancel_all', body);
    }
  );

  // Cancel Stop Order
  server.tool('cancelStopOrder',
    "Cancels an existing stop-loss/take-profit order by symbol and order ID. Example: { \"symbol\": \"BTC\", \"order_id\": 12345 }. Returns { \"success\": true } on success, or { \"error\": \"Stop order not found\", \"code\": 400 } on failure.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      order_id: z.number().describe("ID of the stop loss/take profit order to cancel")
    },
    async ({ symbol, order_id }) => {
      const body = signRequest('cancel_stop_order', { symbol, order_id });
      return makeRequest('POST', '/api/v1/orders/stop/cancel', body);
    }
  );

  // Create Stop Order
  server.tool('createStopOrder',
    "Creates a standalone stop-loss/take-profit order that executes automatically when the trigger price is reached. Trigger and limit prices are decimal strings (not tick levels). Example: { \"symbol\": \"BTC\", \"side\": \"bid\", \"reduce_only\": true, \"stop_order\": { \"stop_price\": \"48000\", \"limit_price\": \"47950\", \"amount\": \"0.1\" } }. Omit limit_price for a market-style stop; omit amount to use the full position size. Returns { \"order_id\": 12345 } on success, or { \"error\": \"Invalid stop order parameters\", \"code\": 400 } on failure.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      stop_order: stopOrderInfoSchema.describe("Stop order configuration (StopOrderInfo): stop_price (decimal string, required), optional limit_price/amount (decimal strings), optional client_order_id (UUID) and trigger_price_type"),
      side: z.string().describe("Order direction: 'bid' (buy) or 'ask' (sell)"),
      reduce_only: z.boolean().describe("Whether to reduce position only; when true, this order can only reduce positions, not increase them")
    },
    async ({ symbol, stop_order, side, reduce_only }) => {
      const body = signRequest('create_stop_order', { symbol, stop_order, side, reduce_only });
      return makeRequest('POST', '/api/v1/orders/stop/create', body);
    }
  );

  // Get Order History By Id
  server.tool('getOrderHistoryById',
    "Retrieves the full event history of a single order by its ID (no pagination). Example: { \"order_id\": 13753364 }. Example response: { \"success\": true, \"data\": [{ \"history_id\": 641452639, \"order_id\": 315992721, \"client_order_id\": \"ade1aa6...\", \"symbol\": \"XPL\", \"side\": \"ask\", \"price\": \"1.0865\", \"initial_amount\": \"984\", \"filled_amount\": \"0\", \"cancelled_amount\": \"984\", \"event_type\": \"cancel\", \"order_type\": \"limit\", \"order_status\": \"cancelled\", \"stop_price\": null, \"stop_parent_order_id\": null, \"reduce_only\": false, \"created_at\": 1759224895038 }], \"error\": null, \"code\": null }. event_type covers the order lifecycle (make, fulfill_limit, fulfill_market, adjust, stop_triggered, cancel, expired, post_only_rejected, ...); order_status is one of open, partially_filled, filled, cancelled, rejected. Returns an empty data array if no history exists for the order_id.",
    {
      order_id: z.number().int().min(0).describe("ID of the order to query history for")
    },
    async ({ order_id }) => makeRequest('GET', '/api/v1/orders/history_by_id', { order_id })
  );

  // Get Order History
  server.tool('getOrderHistory',
    "Retrieves summarized order history (cursor-paginated; all orders for the account, oldest first). Example: { \"limit\": 20 }. Example response: { \"success\": true, \"data\": [{ \"history_id\": 641452639, \"order_id\": 315992721, \"client_order_id\": \"ade1aa6...\", \"symbol\": \"XPL\", \"side\": \"ask\", \"price\": \"1.0865\", \"initial_amount\": \"984\", \"filled_amount\": \"0\", \"cancelled_amount\": \"984\", \"stop_price\": null, \"stop_parent_order_id\": null, \"reduce_only\": false, \"reason\": null, \"order_type\": \"limit\", \"order_status\": \"cancelled\", \"created_at\": 1759224895038, \"updated_at\": 1759224895038 }], \"next_cursor\": \"2VfUX\", \"has_more\": true, \"error\": null, \"code\": null }. order_type is one of limit, market, stop_limit, stop_market, take_profit_limit, stop_loss_limit, take_profit_market, stop_loss_market; amounts are decimal strings; created_at/updated_at are millisecond timestamps. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional, capped 1-4000, default 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) => makeRequest('GET', '/api/v1/orders/history', { account: address, limit, cursor })
  );

  // Create Market Order
  server.tool('createMarketOrder',
    "Creates a market order that executes immediately against the book at up to slippage_percent from the mark price. Amount and slippage_percent are decimal strings. Example: { \"symbol\": \"BTC\", \"amount\": \"0.001\", \"side\": \"bid\", \"slippage_percent\": \"0.5\", \"reduce_only\": false }. Optionally attach take_profit/stop_loss (StopOrderInfo with decimal-string prices). Returns { \"order_id\": 12345 } on success. NOTE: market orders are subject to a ~200ms speed-bump delay to protect liquidity providers. Fails if the book has no liquidity within the slippage band.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      amount: z.string().describe("Order quantity as a decimal string, e.g. '0.001'"),
      side: z.enum(['bid', 'ask']).describe("Order direction: 'bid' (buy) or 'ask' (sell)"),
      slippage_percent: z.string().describe("Max slippage from mark as a decimal-string percentage, e.g. '0.5' for 0.5%"),
      reduce_only: z.boolean().describe("Whether the order may only reduce an existing position"),
      client_order_id: z.string().uuid().optional().describe("Optional client-supplied UUID to track the order"),
      take_profit: stopOrderInfoSchema.optional().describe("Optional take-profit stop order attached to this order"),
      stop_loss: stopOrderInfoSchema.optional().describe("Optional stop-loss stop order attached to this order"),
      builder_code: z.string().optional().describe("Optional builder code (3-16 alphanumeric characters)"),
    },
    async ({ symbol, amount, side, slippage_percent, reduce_only, client_order_id, take_profit, stop_loss, builder_code }) => {
      const body = signRequest('create_market_order', {
        symbol, amount, side, slippage_percent, reduce_only,
        client_order_id, take_profit, stop_loss, builder_code,
      });
      return makeRequest('POST', '/api/v1/orders/create_market', body);
    }
  );

  // Edit Order
  server.tool('editOrder',
    "Edits an existing limit order (cancels the original and creates a new order with TIF=ALO/post-only). Price and amount are decimal strings. Example: { \"symbol\": \"BTC\", \"order_id\": 13753364, \"price\": \"65100\", \"amount\": \"0.002\" }. Omit amount to keep the current size. Returns { \"order_id\": 13754000 } with the NEW order_id (the original is cancelled as part of the edit). NOTE: only order_id locator is supported; client_order_id edit is not exposed (matches the cancelOrder Tier-1b decision).",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      price: z.string().describe("New order price as a decimal string, e.g. '65100'"),
      amount: z.string().optional().describe("Optional new order amount as a decimal string, e.g. '0.002'; omit to keep the current size"),
      order_id: z.number().describe("ID of the order to edit")
    },
    async ({ symbol, price, amount, order_id }) => {
      const body = signRequest('edit_order', { symbol, price, amount, order_id });
      return makeRequest('POST', '/api/v1/orders/edit', body);
    }
  );

  // Set Position TP/SL
  server.tool('setPositionTpsl',
    "Sets take-profit and/or stop-loss orders on an EXISTING position. side is the CLOSING side — the OPPOSITE of the position side ('ask' to protect a long, 'bid' to protect a short); the engine rejects side == position side with 'Invalid stop order side'. At least one of take_profit/stop_loss should be provided; prices are decimal strings inside the StopOrderInfo objects. Example (protecting a BTC long): { \"symbol\": \"BTC\", \"side\": \"ask\", \"take_profit\": { \"stop_price\": \"70000\" }, \"stop_loss\": { \"stop_price\": \"60000\" } }. Returns { \"success\": true }. Fails if there is no open position on the symbol. The created TP/SL appear as stop orders in getOpenOrders and are cancelled by cancelAllOrders.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      side: z.enum(['bid', 'ask']).describe("CLOSING side, opposite of the position: 'ask' to protect a long, 'bid' to protect a short"),
      take_profit: stopOrderInfoSchema.optional().describe("Optional take-profit StopOrderInfo (decimal-string prices)"),
      stop_loss: stopOrderInfoSchema.optional().describe("Optional stop-loss StopOrderInfo (decimal-string prices)"),
      builder_code: z.string().optional().describe("Optional builder code (3-16 alphanumeric characters)"),
    },
    async ({ symbol, side, take_profit, stop_loss, builder_code }) => {
      const body = signRequest('set_position_tpsl', { symbol, side, take_profit, stop_loss, builder_code });
      return makeRequest('POST', '/api/v1/positions/tpsl', body);
    }
  );

  // Add Isolated Margin
  server.tool('addIsolatedMargin',
    "Adds USDC margin to an ISOLATED position. amount is a decimal string. Example: { \"symbol\": \"BTC\", \"amount\": \"10\" }. Returns { \"success\": true }. Fails if the position on the symbol is not in isolated margin mode. Use updateMarginMode to set isolated mode before opening the position.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      amount: z.string().describe("USDC amount to add as a decimal string, e.g. '10'")
    },
    async ({ symbol, amount }) => {
      const body = signRequest('add_isolated_margin', { symbol, amount });
      return makeRequest('POST', '/api/v1/positions/add_isolated_margin', body);
    }
  );

  // Create TWAP Order
  server.tool('createTwapOrder',
    "Creates a TWAP (time-weighted average price) order that splits the total amount into market sub-orders spread over duration_in_seconds. Amount and slippage_percent are decimal strings. Example: { \"symbol\": \"BTC\", \"amount\": \"0.01\", \"side\": \"bid\", \"reduce_only\": false, \"slippage_percent\": \"1\", \"duration_in_seconds\": 3600 }. Returns { \"order_id\": 12345 }. Open TWAPs appear in getOpenTwapOrders and are cancelled with cancelTwapOrder.",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      amount: z.string().describe("Total quantity as a decimal string"),
      side: z.enum(['bid', 'ask']).describe("Order direction: 'bid' (buy) or 'ask' (sell)"),
      reduce_only: z.boolean().describe("Whether the order may only reduce an existing position"),
      slippage_percent: z.string().describe("Max slippage per sub-order as a decimal-string percentage, e.g. '1'"),
      duration_in_seconds: z.number().int().describe("Total execution window in seconds, e.g. 3600"),
      client_order_id: z.string().uuid().optional().describe("Optional client-supplied UUID"),
      builder_code: z.string().optional().describe("Optional builder code (3-16 alphanumeric characters)"),
    },
    async ({ symbol, amount, side, reduce_only, slippage_percent, duration_in_seconds, client_order_id, builder_code }) => {
      const body = signRequest('create_twap_order', {
        symbol, amount, side, reduce_only, slippage_percent, duration_in_seconds, client_order_id, builder_code,
      });
      return makeRequest('POST', '/api/v1/orders/twap/create', body);
    }
  );

  // Cancel TWAP Order
  server.tool('cancelTwapOrder',
    "Cancels an existing TWAP order by symbol and order ID. Example: { \"symbol\": \"BTC\", \"order_id\": 12345 }. Returns { \"success\": true } on success, or { \"success\": true, \"data\": null } as a no-op for nonexistent TWAPs (this endpoint does not return 404).",
    {
      symbol: z.string().describe("Trading pair symbol, e.g., BTC, ETH, etc."),
      order_id: z.number().describe("ID of the TWAP order to cancel")
    },
    async ({ symbol, order_id }) => {
      const body = signRequest('cancel_twap_order', { symbol, order_id });
      return makeRequest('POST', '/api/v1/orders/twap/cancel', body);
    }
  );

  // Get Open TWAP Orders
  server.tool('getOpenTwapOrders',
    "Retrieves all open (running) TWAP orders for the current account. Returns a `{ success, data, error, code }` envelope. Example response: { \"success\": true, \"data\": [{ \"order_id\": 3703886, \"client_order_id\": null, \"symbol\": \"URNM\", \"side\": \"bid\", \"initial_amount\": \"0.3\", \"filled_amount\": \"0\", \"reduce_only\": false, \"slippage_percent\": \"1\", \"planned_sub_order_amount\": \"0.001\", \"planned_sub_order_count\": 300, \"past_sub_order_count\": 0, \"total_filled_value\": \"0\", \"expiration\": 1749577200000, \"created_at\": 1749573600000, \"updated_at\": 1749573600000 }], \"error\": null, \"code\": null }. planned_sub_order_count is how many sub-orders are scheduled; past_sub_order_count is how many have fired; expiration is a millisecond timestamp.",
    {},
    async () => makeRequest('GET', '/api/v1/orders/twap', { account: address })
  );

  // Get TWAP Order History
  server.tool('getTwapOrderHistory',
    "Retrieves the summarized TWAP order history for the current account (cursor-paginated, oldest first). Example: { \"limit\": 20 }. Example response: { \"success\": true, \"data\": [{ \"order_id\": 3703886, \"client_order_id\": null, \"symbol\": \"URNM\", \"side\": \"bid\", \"initial_amount\": \"0.3\", \"filled_amount\": \"0\", \"reduce_only\": false, \"slippage_percent\": \"1\", \"planned_sub_order_amount\": \"0.001\", \"planned_sub_order_count\": 300, \"past_sub_order_count\": 0, \"total_filled_value\": \"0\", \"order_status\": \"open\", \"average_price_of_last_filled_sub_order\": null, \"value_of_last_filled_sub_order\": null, \"expiration\": 1749577200000, \"created_at\": 1749573600000, \"updated_at\": 1749573600000 }], \"next_cursor\": \"2VfUX\", \"has_more\": true, \"error\": null, \"code\": null }. order_status covers the TWAP lifecycle; amounts are decimal strings; timestamps are in milliseconds. Page using next_cursor while has_more is true.",
    {
      limit: z.number().int().optional().describe("Maximum number of records to return (optional, capped 1-4000, default 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional)")
    },
    async ({ limit, cursor }) => makeRequest('GET', '/api/v1/orders/twap/history', { account: address, limit, cursor })
  );

  // Get TWAP Order History By Id
  server.tool('getTwapOrderHistoryById',
    "Retrieves the full per-event history of a single TWAP order by its ID (no pagination). Example: { \"order_id\": 3703886 }. Example response: { \"success\": true, \"data\": [{ \"history_id\": 123, \"order_id\": 3703886, \"client_order_id\": null, \"symbol\": \"URNM\", \"side\": \"bid\", \"initial_amount\": \"0.3\", \"filled_amount\": \"0\", \"event_type\": \"make\", \"reduce_only\": false, \"slippage_percent\": \"1\", \"planned_sub_order_count\": 300, \"past_sub_order_count\": 0, \"order_status\": \"open\", \"average_price_of_last_filled_sub_order\": null, \"value_of_last_filled_sub_order\": null, \"created_at\": 1749573600000, \"updated_at\": 1749573600000 }], \"error\": null, \"code\": null }. event_type covers the TWAP lifecycle (make, sub_order_filled, cancel, expired, ...); returns an empty data array if no history exists for the order_id.",
    {
      order_id: z.number().int().min(0).describe("ID of the TWAP order to query history for")
    },
    async ({ order_id }) => makeRequest('GET', '/api/v1/orders/twap/history_by_id', { order_id })
  );

  // Map the backend BatchAction tag to the signing operation type. Each batch
  // action's data is signed with its own op type (per-action signing -- see
  // request.rs:943-957 and handler/mod.rs:864-897 for the all-or-nothing
  // signature semantics).
  const BATCH_OP_TYPES: Record<string, string> = {
    Create: 'create_order',
    CreateMarket: 'create_market_order',
    Cancel: 'cancel_order',
    SetPositionTpsl: 'set_position_tpsl',
    CancelStopOrder: 'cancel_stop_order',
    Edit: 'edit_order',
  };

  // Batch Orders
  server.tool('batchOrders',
    "Executes up to 10 order actions in one request. Each action is { type, data } where type is one of Create, CreateMarket, Cancel, SetPositionTpsl, CancelStopOrder, Edit and data is the UNSIGNED payload of the corresponding single-action tool (openOrder, createMarketOrder, cancelOrder, setPositionTpsl, cancelStopOrder, editOrder) -- this tool signs each action individually. Example: { \"actions\": [{ \"type\": \"Create\", \"data\": { \"symbol\": \"BTC\", \"price\": \"60000\", \"amount\": \"0.001\", \"side\": \"bid\", \"tif\": \"ALO\", \"reduce_only\": false } }, { \"type\": \"Cancel\", \"data\": { \"symbol\": \"BTC\", \"order_id\": 123 } }] }. Returns { \"results\": [{ \"success\": true, \"order_id\": 124 }, { \"success\": false, \"error\": \"...\" }] } -- results are per-action. NOTE: a signature failure on ANY action rejects the WHOLE batch (400 \"Invalid signature\"); business failures are per-action (200 with per-action success:false). Batches containing CreateMarket or GTC/IOC Create actions are subject to the ~200ms speed-bump delay.",
    {
      actions: z.array(z.object({
        type: z.enum(['Create', 'CreateMarket', 'Cancel', 'SetPositionTpsl', 'CancelStopOrder', 'Edit'])
          .describe("Action kind; selects the op type used to sign this action's data"),
        data: z.record(z.any())
          .describe("Unsigned payload for the action, same fields as the corresponding single-action tool"),
      })).min(1).max(10).describe("1-10 order actions, executed in order"),
    },
    async ({ actions }) => {
      const signed = actions.map(({ type, data }) => ({
        type,
        data: signRequest(BATCH_OP_TYPES[type], data),
      }));
      return makeRequest('POST', '/api/v1/orders/batch', { actions: signed });
    }
  );

  // Get Current Positions
  server.tool('getCurrentPositions',
    "Retrieves all currently held positions. Returns a `{ success, data, error, code }` envelope plus a top-level last_order_id (an exchange-wide ordering nonce). Example response: { \"success\": true, \"data\": [{ \"symbol\": \"AAVE\", \"side\": \"ask\", \"amount\": \"223.72\", \"entry_price\": \"279.283134\", \"margin\": \"0\", \"funding\": \"13.159593\", \"isolated\": false, \"liquidation_price\": null, \"created_at\": 1754928414996, \"updated_at\": 1759223365538 }], \"error\": null, \"code\": null, \"last_order_id\": 1557431179 }. side is bid (long) or ask (short); margin is shown only for isolated positions; liquidation_price is null when not applicable; timestamps are in milliseconds.",
    {},
    async (): Promise<ApiResponse> => makeRequest('GET', '/api/v1/positions', { account: address })
  );

  // Get Position History
  server.tool('getPositionHistory',
    "Retrieves the account's trade/fill history, i.e. per-fill position changes (cursor-paginated; start_time/end_time limited to a 30-day range). Example: { \"symbol\": \"BTC\", \"limit\": 20 }. Example response: { \"success\": true, \"data\": [{ \"history_id\": 19329801, \"order_id\": 315293920, \"client_order_id\": \"acf...\", \"symbol\": \"LDO\", \"amount\": \"0.1\", \"price\": \"1.1904\", \"entry_price\": \"1.176247\", \"fee\": \"0\", \"pnl\": \"-0.001415\", \"event_type\": \"fulfill_maker\", \"side\": \"close_short\", \"created_at\": 1759215599188, \"cause\": \"normal\" }], \"next_cursor\": \"11111Z5RK\", \"has_more\": true }. event_type is fulfill_taker or fulfill_maker; side is open_long/open_short/close_long/close_short; cause is normal/market_liquidation/backstop_liquidation/settlement. Page using next_cursor while has_more is true.",
    {
      symbol: z.string().optional().describe("Trading pair to filter by (optional)"),
      limit: z.number().int().optional().describe("Maximum number of records to return (optional, capped 1-4000, default 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor (optional). Replaces deprecated offset pagination."),
      start_time: z.number().optional().describe("Start time in milliseconds (optional). Max 30-day range with end_time."),
      end_time: z.number().optional().describe("End time in milliseconds (optional). Max 30-day range with start_time.")
    },
    async ({ symbol, limit, cursor, start_time, end_time }) => {
      return makeRequest('GET', '/api/v1/trades/history', {
        account: address,
        symbol,
        limit,
        start_time,
        end_time,
        cursor
      });
    }
  );
}
