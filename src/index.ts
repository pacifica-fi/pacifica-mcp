#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMarketTools } from './tools/markets.js';
import { registerAccountTools } from './tools/account.js';
import { registerOrderTools } from './tools/orders.js';
import { registerSpotTools } from './tools/spot.js';
import { registerFaucetTools, isFaucetEnabled } from './tools/faucet.js';
import { registerDepositTools } from './tools/deposit.js';
import { BASE_URL, address, privateKey, agentPrivateKey, agentWallet } from './helpers.js';

// Create an MCP server
const server = new McpServer({
  name: 'Pacifica Exchange API',
  version: '0.0.1'
});

registerMarketTools(server);
registerAccountTools(server);
registerOrderTools(server);
registerSpotTools(server);

if (isFaucetEnabled(BASE_URL)) {
  registerFaucetTools(server);
}

// deposit works on testnet and mainnet; the handler enforces config + key.
registerDepositTools(server);

// Report the active auth mode on stderr (stdout is the JSON-RPC channel and must
// not be polluted). agent-key mode signs with AGENT_PRIVATE_KEY and sends
// agent_wallet; read-only mode (no key) serves GET tools only.
const mode = agentPrivateKey ? 'agent-key' : privateKey ? 'main-key' : 'read-only';
console.error(
  `[pacifica-mcp] account=${address ?? '(ADDRESS unset!)'} mode=${mode}` +
  (agentPrivateKey ? ` agent_wallet=${agentWallet}` : '')
);
if (!address) console.error('[pacifica-mcp] WARNING: ADDRESS not set — all tools will fail.');

const transport = new StdioServerTransport();
await server.connect(transport);
