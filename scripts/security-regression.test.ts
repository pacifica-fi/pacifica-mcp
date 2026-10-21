import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { ata } from '../src/tools/onchain.js';

// Reference addresses captured from @solana/spl-token before its removal.
const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const owner = new PublicKey('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
const pda = new PublicKey('7r2rjR7jFxon9bpsEi3Gt5CQFLV5JD7BpdQmXMZKBfre');

test('token account derivation preserves wallet and PDA addresses', () => {
  assert.equal(ata(mint, owner).toBase58(), '7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK');
  assert.equal(ata(mint, pda, true).toBase58(), 'BaLS6WNVXwqqB2fKNqf3cqbxHqtLJwa5bdzLvP5c1ov3');
  assert.throws(() => ata(mint, pda), /on curve/);
});

test('patched TOML parser accepts the Buffer input used by Anchor', () => {
  const require = createRequire(import.meta.url);
  const anchorRequire = createRequire(require.resolve('@coral-xyz/anchor'));
  const toml = anchorRequire('toml');
  const parsed = toml.parse(Buffer.from('[programs.localnet]\npacifica = "example"\n'));
  assert.equal(parsed.programs.localnet.pacifica, 'example');
});
