// src/helpers.ts — shared transport + signing for all tool modules.
// Moved verbatim from src/index.ts in the Tier 3 restructure; behavior unchanged.
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

// Host only; request paths include the `/api/v1` prefix. Override via env for
// production (https://api.pacifica.fi) or any other deployment.
export const BASE_URL: string = process.env.PACIFICA_BASE_URL ?? 'https://test-api.pacifica.fi';

// Solana RPC used by on-chain tools (faucet mint). Defaults to the public devnet
// endpoint; set SOLANA_RPC_URL to a private/dedicated RPC (e.g. Helius) to avoid
// public rate limits. NEVER hardcode an RPC with an embedded API key.
export const SOLANA_RPC_URL: string = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

// Account the actions apply to (main account or subaccount public address). Required.
export let address: string | undefined = process.env.ADDRESS;

// Main-account secret key (base58, Solana 64-byte). Optional.
export let privateKey: string | undefined = process.env.PRIVATE_KEY;

// API agent ("agent wallet") secret key (base58). When set, requests are signed
// with this key and `agent_wallet` is sent so the API verifies against the agent
// while applying the action to `account` (= ADDRESS). Lets the MCP trade without
// the main wallet's key. The agent must already be bound to ADDRESS.
export let agentPrivateKey: string | undefined = process.env.AGENT_PRIVATE_KEY;

// Agent pubkey = last 32 bytes of the Solana keypair; AGENT_WALLET overrides.
const deriveAgentWallet = (secretKeyB58: string): string =>
  bs58.encode(nacl.sign.keyPair.fromSecretKey(bs58.decode(secretKeyB58)).publicKey);

export const agentWallet: string | undefined =
  process.env.AGENT_WALLET ?? (agentPrivateKey ? deriveAgentWallet(agentPrivateKey) : undefined);

// Key actually used to sign: the agent key takes precedence over the main key.
const signingKey: string | undefined = agentPrivateKey ?? privateKey;

// Define response type
export interface ApiResponse {
  content: Array<{
    type: "text";
    text: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// Helper function to make API requests.
// GET sends data as query params; POST (and other methods) send a JSON body.
export const makeRequest = async (
  method: string,
  path: string,
  data?: Record<string, any>,
): Promise<ApiResponse> => {
  const url: string = `${BASE_URL}${path}`;
  const config: AxiosRequestConfig =
    method.toUpperCase() === 'GET'
      ? { method, url, params: data }
      : { method, url, data, headers: { 'Content-Type': 'application/json' } };
  const response: AxiosResponse = await axios(config);
  return {
    content: [{
      type: "text",
      text: JSON.stringify(response.data)
    }]
  };
};

export const signMessage = (message: string): string => {
  if (!signingKey) {
    throw new Error(
      'Read-only mode: set PRIVATE_KEY or AGENT_PRIVATE_KEY to enable signed (POST) actions.'
    );
  }
  const messageBytes: Uint8Array = new Uint8Array(Buffer.from(message));
  const secretKey: Uint8Array = bs58.decode(signingKey);
  const signature: Uint8Array = nacl.sign.detached(messageBytes, secretKey);
  return bs58.encode(signature);
};

// Signed requests expire this many milliseconds after `timestamp` (API default).
export const EXPIRY_WINDOW = 30_000;

// Recursively sort object keys alphabetically. Required so the signed message is
// deterministic: JSON.stringify preserves insertion order, but the API verifies
// against an alphabetically key-sorted serialization.
export const sortJsonKeys = (value: any): any => {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortJsonKeys(value[key]);
      return acc;
    }, {} as Record<string, any>);
  }
  return value;
};

// Build the signed body for a POST operation. Signs an Ed25519 signature over the
// compact, key-sorted JSON of `{ ...header, data: payload }` where the header is
// `{ timestamp, expiry_window, type }`. The `data` wrapper is only used for
// signing; the request body flattens the header fields together with the payload.
export const signRequest = (
  type: string,
  payload: Record<string, any>,
): Record<string, any> => {
  if (!address) throw new Error('Address not set');
  const timestamp = Date.now();
  const expiry_window = EXPIRY_WINDOW;
  const message = JSON.stringify(
    sortJsonKeys({ timestamp, expiry_window, type, data: payload })
  );
  const signature = signMessage(message);
  // agent_wallet is sent ONLY in agent-key mode and is NOT part of the signed
  // message. JSON.stringify drops it when undefined, so main-key mode emits a
  // byte-identical body to before (backward compatible).
  return { account: address, agent_wallet: agentWallet, signature, timestamp, expiry_window, ...payload };
};
