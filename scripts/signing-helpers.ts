/**
 * Shared smoke-test helpers.
 *
 * Owns the signing scheme, axios request wrappers, and response-classification
 * heuristics used by every scripts/smoke*.ts harness. Previously each smoke
 * script carried a verbatim copy of this preamble (DU-001); they now import it
 * from here.
 *
 * The signing logic below is intentionally a self-contained copy of the helpers
 * in src/index.ts (sortJsonKeys / signMessage / signRequest / tamperSignature):
 * the smoke tests re-implement signing independently of the server so they can
 * catch a regression in src/index.ts's signing. This file lives under scripts/
 * (NOT src/), so that independence is preserved -- it only deduplicates the copy
 * across the smoke scripts. Keep it in sync with src/index.ts if the scheme
 * changes.
 */
import axios from 'axios';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export const BASE_URL: string = process.env.PACIFICA_BASE_URL ?? 'https://test-api.pacifica.fi';
export const privateKey: string | undefined = process.env.PRIVATE_KEY;
export const address: string | undefined = process.env.ADDRESS;
export const EXPIRY_WINDOW = 30_000;

// --- signing helpers (mirror of src/index.ts) ------------------------------

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

export const signMessage = (message: string): string => {
  if (!privateKey) throw new Error('PRIVATE_KEY not set');
  const messageBytes = new Uint8Array(Buffer.from(message));
  const secretKey = bs58.decode(privateKey);
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return bs58.encode(signature);
};

// Sign `type + payload` with an arbitrary keypair. The signing scheme is
// identical to signRequest; this exists so the Layer-3 maker rig (smoke-3e)
// can sign for two accounts (taker + maker) from one implementation.
export const signAs = (
  priv: string, addr: string, type: string, payload: Record<string, any>
): Record<string, any> => {
  const timestamp = Date.now();
  const expiry_window = EXPIRY_WINDOW;
  const message = JSON.stringify(sortJsonKeys({ timestamp, expiry_window, type, data: payload }));
  const signature = bs58.encode(nacl.sign.detached(
    new Uint8Array(Buffer.from(message)), bs58.decode(priv)));
  return { account: addr, signature, timestamp, expiry_window, ...payload };
};

export const signRequest = (type: string, payload: Record<string, any>): Record<string, any> => {
  if (!privateKey || !address) throw new Error('PRIVATE_KEY/ADDRESS not set');
  return signAs(privateKey, address, type, payload);
};

// Derive an agent wallet pubkey from its base58 secret key.
export const deriveAgentWallet = (secretKeyB58: string): string =>
  bs58.encode(nacl.sign.keyPair.fromSecretKey(bs58.decode(secretKeyB58)).publicKey);

// Sign as an API agent key: signs with the agent's private key, but the body
// carries account=<main/sub address> and agent_wallet=<agent pubkey>. The API
// verifies the signature against agent_wallet and applies the action to account.
// agent_wallet is NOT part of the signed message. Independent re-implementation
// of src/helpers.ts agent-mode signing (kept under scripts/ to catch regressions).
export const signAsAgent = (
  account: string, agentPriv: string, type: string, payload: Record<string, any>
): Record<string, any> => {
  const agent_wallet = deriveAgentWallet(agentPriv);
  const timestamp = Date.now();
  const expiry_window = EXPIRY_WINDOW;
  const message = JSON.stringify(sortJsonKeys({ timestamp, expiry_window, type, data: payload }));
  const signature = bs58.encode(nacl.sign.detached(
    new Uint8Array(Buffer.from(message)), bs58.decode(agentPriv)));
  return { account, agent_wallet, signature, timestamp, expiry_window, ...payload };
};

// Corrupt a base58 signature by flipping one byte, keeping it valid base58 so
// the server decodes it to a (different, therefore invalid) signature.
export const tamperSignature = (sig: string): string => {
  const bytes = bs58.decode(sig);
  bytes[0] = bytes[0] ^ 0x01;
  return bs58.encode(bytes);
};

// --- request + classification ----------------------------------------------

export interface Outcome { status: number | string; body: any; }

export const get = async (path: string, params: Record<string, any>): Promise<Outcome> => {
  try {
    const res = await axios({ method: 'GET', url: `${BASE_URL}${path}`, params });
    return { status: res.status, body: res.data };
  } catch (err: any) {
    if (err.response) return { status: err.response.status, body: err.response.data };
    return { status: 'NETWORK_ERROR', body: err.message };
  }
};

export const post = async (path: string, body: Record<string, any>): Promise<Outcome> => {
  try {
    const res = await axios({
      method: 'POST',
      url: `${BASE_URL}${path}`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
    return { status: res.status, body: res.data };
  } catch (err: any) {
    if (err.response) return { status: err.response.status, body: err.response.data };
    return { status: 'NETWORK_ERROR', body: err.message };
  }
};

// Heuristic: signature/auth rejection. Pacifica returns the bare string
// "Verification failed" on a bad signature.
export const looksLikeSignatureRejection = (o: Outcome): boolean => {
  const text = JSON.stringify(o.body).toLowerCase();
  return /signature|unauthorized|invalid.*sign|verification failed/.test(text);
};

// Heuristic: request-body / query deserialize rejection (missing/required field,
// wrong type, unknown field).
export const looksLikeDeserializeError = (o: Outcome): boolean => {
  const text = JSON.stringify(o.body).toLowerCase();
  return /deserialize|missing field|invalid type|unknown field/.test(text);
};

// Heuristic: a "not found" response. For a by-ID endpoint, a 404 whose body
// mentions "not found" is the HEALTHY response for a nonexistent id and proves
// routing + param shape are correct.
export const looksLikeNotFound = (o: Outcome): boolean => {
  const text = JSON.stringify(o.body).toLowerCase();
  return o.status === 404 || /not found/.test(text);
};

export const log = (s: string) => console.log(s);
export const ok = (s: string) => `✓ ${s}`;
export const no = (s: string) => `✗ ${s}`;
