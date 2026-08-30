// src/helpers.ts — shared transport + signing for all tool modules.
// Moved verbatim from src/index.ts in the Tier 3 restructure; behavior unchanged.
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { DRY_RUN, dryRunResult } from './limits.js';

// Host only; request paths include the `/api/v1` prefix. Override via env for
// production (https://api.pacifica.fi) or any other deployment.
export const BASE_URL: string = process.env.PACIFICA_BASE_URL ?? 'https://test-api.pacifica.fi';

// Every request is bounded. axios applies no timeout by default, which for an MCP
// server means a stalled connection hangs the tool call indefinitely: the model gets
// no result and no error, and the operator sees a wedged session rather than a failed
// request. It matters more for signed actions than for reads, because a signed body
// carries an `expiry_window` (see EXPIRY_WINDOW below) — a request that finally lands
// after a long stall is rejected as expired, while the model, having received nothing,
// may already have retried and placed the order twice.
export const REQUEST_TIMEOUT_MS: number = Number(process.env.PACIFICA_TIMEOUT_MS ?? 10_000);

// Hosts this server knows how to talk to, and which network each one is.
//
// The network is not cosmetic: it selects the on-chain program id and the USDC mint a
// deposit is sent to (see src/tools/onchain.ts). Resolving it by asking whether the
// base URL *contains* the testnet host meant that every value which did not — a typo,
// a local proxy, an unrelated URL — was classified as mainnet and got mainnet
// addresses. An explicit table makes an unrecognised host an error instead, so the
// failure mode is a refused tool call rather than a real-funds transfer against a
// deployment nobody chose.
export const KNOWN_HOSTS: Readonly<Record<string, 'testnet' | 'mainnet'>> = Object.freeze({
  'test-api.pacifica.fi': 'testnet',
  'api.pacifica.fi': 'mainnet',
});

/**
 * Classify a REST base URL as testnet or mainnet.
 *
 * An unknown host requires the operator to state the network explicitly via
 * `PACIFICA_NETWORK=testnet|mainnet`, which is the seam that keeps a private proxy or
 * a staging deployment usable without making "mainnet" the silent default. A non-HTTPS
 * URL is rejected outright: these requests carry Ed25519-signed order payloads, and
 * over plain HTTP those are readable and replayable in transit by anyone on the path.
 */
export const classifyBaseUrl = (
  baseUrl: string,
): { network: 'testnet' | 'mainnet' } | { error: string } => {
  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(baseUrl);
    host = parsed.hostname;
    protocol = parsed.protocol;
  } catch {
    return { error: `PACIFICA_BASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}` };
  }

  // `localhost` is exempt so a developer can run against a local mock; nothing else is.
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (protocol !== 'https:' && !isLocal) {
    return { error: `PACIFICA_BASE_URL must use https (got ${protocol}//${host}).` };
  }

  const known = KNOWN_HOSTS[host];
  if (known) return { network: known };

  const declared = process.env.PACIFICA_NETWORK;
  if (declared === 'testnet' || declared === 'mainnet') return { network: declared };

  return {
    error:
      `Unrecognised Pacifica host ${JSON.stringify(host)}. Known hosts: ` +
      `${Object.keys(KNOWN_HOSTS).join(', ')}. To use another deployment, set ` +
      `PACIFICA_NETWORK=testnet or PACIFICA_NETWORK=mainnet explicitly — it is not ` +
      `inferred, because guessing wrong selects the wrong USDC mint and program id.`,
  };
};

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
  // MCP's signal that a tool call failed. Without it a failure is indistinguishable
  // from a success to the model, which is the dangerous direction here: an order that
  // was rejected would be reported as placed, and the model would reason — and possibly
  // place further orders — on top of a position that does not exist.
  isError?: boolean;
  [key: string]: unknown;
}

// Shape of an unsuccessful Pacifica REST response. The API answers some failures with
// HTTP 200 and `success: false`, so the status code alone is not the outcome.
interface PacificaErrorBody {
  success?: boolean;
  error?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Decide whether a response represents a failure, and describe it.
 *
 * Two independent failure signals are checked, because either can occur alone:
 *   - a non-2xx HTTP status, and
 *   - `success: false` (or a populated `error`/`code`) in an HTTP 200 body.
 *
 * Returns `null` when the response is a success.
 */
const describeFailure = (response: AxiosResponse): string | null => {
  const body: PacificaErrorBody | undefined =
    response.data && typeof response.data === 'object' ? response.data : undefined;

  const apiError = body?.error ?? body?.message;
  const apiSaysFailed = body?.success === false || apiError != null;
  const httpFailed = response.status < 200 || response.status >= 300;
  if (!httpFailed && !apiSaysFailed) return null;

  const parts: string[] = [];
  if (httpFailed) parts.push(`HTTP ${response.status}`);
  if (body?.code != null) parts.push(`code ${JSON.stringify(body.code)}`);
  if (apiError != null) {
    parts.push(typeof apiError === 'string' ? apiError : JSON.stringify(apiError));
  }
  // The raw body is included when the API gave no recognisable error field, so a
  // failure is never reported as an empty message.
  if (parts.length === 0) parts.push(JSON.stringify(response.data));
  return parts.join(' — ');
};

// Helper function to make API requests.
// GET sends data as query params; POST (and other methods) send a JSON body.
export const makeRequest = async (
  method: string,
  path: string,
  data?: Record<string, any>,
): Promise<ApiResponse> => {
  const url: string = `${BASE_URL}${path}`;
  const config: AxiosRequestConfig = {
    method,
    url,
    timeout: REQUEST_TIMEOUT_MS,
    // Non-2xx is handled below instead of thrown. axios' default is to throw, which
    // discarded the response body — and the body is where Pacifica puts the reason the
    // request was refused ("insufficient margin", "market closed", a rate-limit code).
    // The model needs that text to react correctly; a bare "Request failed with status
    // code 400" invites a blind retry of a request that will fail the same way.
    validateStatus: () => true,
    ...(method.toUpperCase() === 'GET'
      ? { params: data }
      : { data, headers: { 'Content-Type': 'application/json' } }),
  };

  let response: AxiosResponse;
  try {
    response = await axios(config);
  } catch (err: unknown) {
    // Reached only for transport-level failures now: DNS, connection refused, TLS, or
    // the timeout above. Reported as a tool error rather than rethrown so the model
    // sees a result it can reason about instead of an opaque server-side exception.
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Request to ${method.toUpperCase()} ${path} failed: ${message}` }],
      isError: true,
    };
  }

  const failure = describeFailure(response);
  if (failure) {
    return {
      content: [{ type: "text", text: `${method.toUpperCase()} ${path} failed: ${failure}` }],
      isError: true,
    };
  }

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

/**
 * Sign a payload and submit it, unless the operator has enabled dry-run mode.
 *
 * Every tool that spends money routes through this one function rather than calling
 * `signRequest` + `makeRequest` directly, so `PACIFICA_DRY_RUN` cannot be honoured by
 * some tools and silently ignored by others — a half-applied dry run is worse than none,
 * because the operator believes nothing is being submitted.
 */
export const submitSigned = async (
  operation: string,
  path: string,
  payload: Record<string, any>,
): Promise<ApiResponse> => {
  if (DRY_RUN) return dryRunResult(operation, payload);
  return makeRequest('POST', path, signRequest(operation, payload));
};

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
