// src/limits.ts — input validation and operator-set safety limits for the tools.
//
// This server is driven by a language model: the arguments below are chosen by the
// model, not typed by a person, and every signing tool submits immediately with no
// confirmation step. Two consequences shape this file.
//
// First, "decimal string" was documentation, not a constraint. `z.string()` accepts
// `"1e9"`, `"0.1abc"`, `"-5"`, `""` and `"Infinity"` alike, and those were forwarded
// into a signed order payload. The API rejects most of them, but a rejection costs a
// round trip and — because the old transport discarded error bodies — arrived back as
// an opaque failure the model was likely to retry.
//
// Second, nothing bounded the size of what could be submitted. A model that
// misreads a balance, or is steered by hostile text in a prompt or in market data it
// was shown, could place an order orders of magnitude larger than intended. The caps
// here are the operator's, set by environment variable and enforced locally, so they
// hold regardless of what the model decides. They are deliberately opt-in: absent
// configuration the behaviour is unchanged, so this cannot silently break an existing
// deployment.
import { z } from 'zod';

/**
 * A non-negative decimal number written as a string, with at most `maxDecimals` places.
 *
 * Scientific notation is refused on purpose: `"1e3"` is a perfectly good number to a
 * JSON parser and a catastrophic typo in an order size, and the API's own examples are
 * always plain decimals. Rejecting it locally keeps the signed payload identical in
 * form to what a human would have written.
 */
export const decimalString = (opts: { maxDecimals?: number; label?: string } = {}) => {
  const maxDecimals = opts.maxDecimals ?? 18;
  const label = opts.label ?? 'value';
  return z
    .string()
    .regex(
      new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${maxDecimals}})?$`),
      `${label} must be a plain positive decimal string such as "0.001" or "65000.5" ` +
        `(no sign, no exponent, at most ${maxDecimals} decimal places)`,
    )
    .refine((v) => Number(v) > 0, `${label} must be greater than zero`);
};

/** Price, amount and slippage share the same shape; the labels differ for the error text. */
export const priceString = decimalString({ label: 'price' });
export const amountString = decimalString({ label: 'amount' });

/**
 * A percentage as a decimal string, bounded at 100.
 *
 * A slippage tolerance above 100% is not a tolerance, it is an instruction to fill at
 * any price. That is the single most expensive thing a mistyped argument can do here.
 */
export const percentString = decimalString({ label: 'percent', maxDecimals: 6 }).refine(
  (v) => Number(v) <= 100,
  'percent must be at most 100',
);

/** Builder codes are documented as 3-16 alphanumeric characters. */
export const builderCode = z
  .string()
  .regex(/^[A-Za-z0-9]{3,16}$/, 'builder_code must be 3-16 alphanumeric characters');

// Pacifica's supported leverage range. Bounded so a value from another venue's scale,
// or an extra digit, is refused before it changes the account's risk profile.
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 50;
export const leverageValue = z.number().int().min(MIN_LEVERAGE).max(MAX_LEVERAGE);

const readPositiveEnv = (name: string): number | null => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
};

/**
 * Operator-set ceiling on a single order's size, in units of the traded asset.
 *
 * Unset by default. When set, it is checked locally before signing, so it cannot be
 * argued out of by the model the way a prompt-level instruction can.
 */
export const MAX_ORDER_AMOUNT: number | null = readPositiveEnv('PACIFICA_MAX_ORDER_AMOUNT');

/** Operator-set ceiling on a single deposit, in USDC. Unset by default. */
export const MAX_DEPOSIT_AMOUNT: number | null = readPositiveEnv('PACIFICA_MAX_DEPOSIT_AMOUNT');

/**
 * When set, no signing tool submits: each returns the payload it *would* have sent.
 *
 * This exists so an operator can watch what a model actually does with these tools for
 * a while before letting it move funds — the honest way to evaluate an agent's trading
 * behaviour, rather than reading its explanation of what it intends to do.
 */
export const DRY_RUN: boolean = /^(1|true|yes)$/i.test(process.env.PACIFICA_DRY_RUN ?? '');

/**
 * Enforce a configured ceiling. Returns an error string, or `null` when allowed.
 *
 * The message names the environment variable so the person reading the transcript can
 * tell an operator-set limit apart from an exchange-side rejection.
 */
export const checkCeiling = (
  value: string | number,
  ceiling: number | null,
  opts: { label: string; envVar: string },
): string | null => {
  if (ceiling === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `${opts.label} is not a finite number.`;
  if (numeric > ceiling) {
    return (
      `${opts.label} ${numeric} exceeds the operator-configured limit of ${ceiling} ` +
      `(${opts.envVar}). Raise that limit deliberately if this is intended.`
    );
  }
  return null;
};

/** A refusal in MCP tool-result form, so the model sees a failure rather than a success. */
export const refuse = (text: string) => ({
  content: [{ type: 'text' as const, text: `Refused: ${text}` }],
  isError: true,
});

/** A dry-run result: the exact payload that would have been submitted. */
export const dryRunResult = (operation: string, payload: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        dry_run: true,
        operation,
        note: 'PACIFICA_DRY_RUN is set; nothing was submitted.',
        payload,
      }),
    },
  ],
});
