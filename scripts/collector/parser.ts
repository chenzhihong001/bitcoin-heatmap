export type ParsedLiquidation = {
  symbol: string;
  side: "long" | "short";
  amountValue: number;
  amountUnit: "usd" | "contracts";
  notionalUsd: number | null;
  price: number;
};

const LIQUIDATION_PATTERN = /#([A-Z0-9]+)\s+Liquidated\s+(Long|Short):\s+\$?([0-9]+(?:\.[0-9]+)?)([KMB])?\s*(contracts?)?\s+at\s+\$([0-9]+(?:\.[0-9]+)?)/i;

export function parseLiquidationMessage(text: string): ParsedLiquidation | null {
  const match = LIQUIDATION_PATTERN.exec(text.trim());
  if (!match) return null;

  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[4]?.toUpperCase() ?? ""] ?? 1;
  const notionalUsd = Number(match[3]) * multiplier;
  const price = Number(match[6]);
  const side = match[2].toLowerCase();
  const amountUnit = match[5] ? "contracts" : "usd";

  if (!Number.isFinite(notionalUsd) || !Number.isFinite(price) || (side !== "long" && side !== "short")) return null;

  return {
    symbol: match[1].toUpperCase(),
    side,
    amountValue: notionalUsd,
    amountUnit,
    notionalUsd: amountUnit === "usd" ? notionalUsd : null,
    price,
  };
}