import path from "node:path";
import { openDatabase } from "../../../../scripts/collector/database";

export const dynamic = "force-dynamic";

const timeframeMinutes: Record<string, number> = {
  "15M": 15,
  "1H": 60,
  "4H": 240,
  "12H": 720,
  "1D": 1440,
  "1W": 10080,
  "1M": 43200,
  "3M": 129600,
  "6M": 259200,
  "1Y": 525600,
};

type EventRow = {
  exchange: "binance" | "bybit";
  symbol: string;
  side: string;
  eventTime: number;
  price: number;
  amountValue: number;
  amountUnit: string;
  notionalUsd: number | null;
  sourceChannel: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const timeframe = url.searchParams.get("timeframe") ?? "1D";
  const exchange = url.searchParams.get("exchange");
  const symbol = url.searchParams.get("symbol") ?? "BTC";
  const minutes = timeframeMinutes[timeframe];

  if (!minutes) {
    return Response.json({ error: `Unsupported timeframe: ${timeframe}` }, { status: 400 });
  }
  if (exchange && exchange !== "binance" && exchange !== "bybit") {
    return Response.json({ error: `Unsupported exchange: ${exchange}` }, { status: 400 });
  }

  const database = openDatabase(path.join(process.cwd(), "data", "liquidations.sqlite"));
  try {
    const exchangeClause = exchange ? "AND exchange = @exchange" : "";
    const latest = database.prepare(`
      SELECT MAX(event_time) AS latestEventTime
      FROM liquidation_events
      WHERE symbol = @symbol ${exchangeClause}
    `).get({ symbol, exchange }) as { latestEventTime: number | null };

    if (!latest.latestEventTime) {
      return Response.json({
        timeframe,
        exchange: exchange ?? "all",
        symbol,
        events: [],
        coverage: null,
      });
    }

    const fromTime = latest.latestEventTime - minutes * 60_000;
    const rows = database.prepare(`
      SELECT
        exchange,
        symbol,
        side,
        event_time AS eventTime,
        price,
        amount_value AS amountValue,
        amount_unit AS amountUnit,
        notional_usd AS notionalUsd,
        source_channel AS sourceChannel
      FROM liquidation_events
      WHERE symbol = @symbol
        ${exchangeClause}
        AND event_time >= @fromTime
        AND event_time <= @latestEventTime
      ORDER BY event_time DESC
      LIMIT 5000
    `).all({ symbol, exchange, fromTime, latestEventTime: latest.latestEventTime }) as EventRow[];

    const coverage = database.prepare(`
      SELECT
        COUNT(*) AS eventCount,
        SUM(CASE WHEN notional_usd IS NOT NULL THEN notional_usd ELSE 0 END) AS notionalUsd,
        SUM(CASE WHEN notional_usd IS NULL THEN 1 ELSE 0 END) AS nonUsdCount,
        MIN(event_time) AS oldestEventTime,
        MAX(event_time) AS newestEventTime
      FROM liquidation_events
      WHERE symbol = @symbol
        ${exchangeClause}
        AND event_time >= @fromTime
        AND event_time <= @latestEventTime
    `).get({ symbol, exchange, fromTime, latestEventTime: latest.latestEventTime }) as {
      eventCount: number;
      notionalUsd: number | null;
      nonUsdCount: number;
      oldestEventTime: number | null;
      newestEventTime: number | null;
    };

    return Response.json({
      timeframe,
      exchange: exchange ?? "all",
      symbol,
      events: rows,
      truncated: coverage.eventCount > rows.length,
      coverage,
    });
  } finally {
    database.close();
  }
}
