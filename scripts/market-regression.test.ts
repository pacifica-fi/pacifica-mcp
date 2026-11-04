import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BASE_URL } from '../src/helpers.js';
import { registerMarketTools } from '../src/tools/markets.js';

const server = new McpServer({ name: 'market-regression', version: '1.0.0' });
const client = new Client({ name: 'market-regression-client', version: '1.0.0' });
const originalAdapter = axios.defaults.adapter;
const requests: Array<{ method: string | undefined; url: URL }> = [];
const response = { success: true, data: [], error: null, code: null };

before(async () => {
  // All HTTP requests terminate here; these tests never contact an exchange.
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: new URL(axios.getUri(config)) });
    return { data: response, status: 200, statusText: 'OK', headers: {}, config };
  };
  registerMarketTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  axios.defaults.adapter = originalAdapter;
  await client.close();
  await server.close();
});

for (const [name, path] of [
  ['getKline', '/api/v1/kline'],
  ['getMarkPriceKline', '/api/v1/kline/mark'],
] as const) {
  for (const interval of ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '1w', '1M']) {
    test(`${name} forwards the documented ${interval} interval unchanged`, async () => {
      requests.length = 0;
      const args = { symbol: 'BTC', interval, start_time: 1780272000000, end_time: 1780876800000 };
      const result = await client.callTool({ name, arguments: args });

      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'get');
      assert.equal(`${requests[0].url.origin}${requests[0].url.pathname}`, `${BASE_URL}${path}`);
      assert.deepEqual(
        Object.fromEntries(requests[0].url.searchParams),
        Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])),
      );
      assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(response) }]);
    });
  }

  test(`${name} rejects unsupported intervals before making an HTTP request`, async () => {
    for (const interval of ['1W', '1mo', '6h']) {
      requests.length = 0;
      const result = await client.callTool({
        name,
        arguments: { symbol: 'BTC', interval, start_time: 1780272000000 },
      });
      assert.equal(result.isError, true);
      assert.equal(requests.length, 0);
    }
  });
}
