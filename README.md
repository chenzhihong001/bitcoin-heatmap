# Liquid / Map

Bitcoin liquidation dashboard and data collector. The project currently combines a live Binance dashboard with a local SQLite database populated from public Telegram liquidation feeds for Binance and Bybit.

## Current Status

The project has two working parts.

### Dashboard

Implemented:

- Next.js App Router with TypeScript, Tailwind CSS, and Turbopack.
- Live BTCUSDT mark price from the Binance USD-M Futures WebSocket.
- Initial price and 24-hour change from the Binance ticker REST endpoint.
- Open interest and current funding rate from Binance REST endpoints.
- Confirmed public force-order events from the Binance WebSocket.
- Responsive trading dashboard with a heatmap, current-price line, inspector, metrics, and feed status.
- Clickable heatmap cells, timeframe controls (`15M`, `1H`, `4H`, `12H`, `1D`, `1W`, `1M`, `3M`, `6M`, `1Y`), and price-range zoom controls.
- Mouse-wheel zoom on the heatmap and explicit plus/minus range controls.
- Explicit separation between modeled liquidation levels and confirmed observed events.

### Telegram collector

Implemented:

- Telegram user-account authentication through GramJS.
- Historical backfill from `@BinanceLiquidations` and `@BybitLiquidations`.
- Continuous listener command for new messages.
- Separate Binance and Bybit exchange fields and source channels.
- SQLite persistence with raw-message retention and duplicate protection.
- Support for USD-denominated messages and older contract-denominated messages.
- Parse-failure and ingestion-run records.

The local database currently contains approximately 99,399 Binance events and 99,893 Bybit events from the 100,000-message backfill limit. The collected coverage is different by source:

| Source | Approximate coverage |
| --- | --- |
| Binance Telegram feed | March 2020 to December 2021 |
| Bybit Telegram feed | November 2022 to January 2025 |

These are observed Telegram feed events, not a complete record of every exchange liquidation. Some older messages report contracts instead of USD notional and are stored without a fabricated USD conversion.

### Not yet complete

- The continuous collector has been tested locally but is not running on a server yet.
- Oracle Cloud VM creation is paused because `VM.Standard.A1.Flex` capacity was unavailable in the selected availability domain.
- The dashboard does not yet read the historical SQLite database.
- Historical replay, source filters, coverage indicators, and cross-exchange aggregation are not implemented.
- The current leverage heatmap is a client-side scenario estimator. It uses current mark price, aggregate open interest, fixed leverage buckets, and maintenance-margin assumptions; it does not observe trader leverage or position entry prices.
- Binance does not expose each trader's leverage or liquidation price, so modeled levels are not guaranteed liquidation prices.
- The recommended product direction is to make observed liquidation events the primary heatmap, keep the estimator as an optional scenario view, and later add a statistically calibrated model with uncertainty. See [RESEARCH.md](RESEARCH.md).
- `1M`, `3M`, `6M`, and `1Y` remain unavailable in the dashboard until real historical rendering is connected.

## Development

Node.js LTS and npm are required. Start the development server from the project directory:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Available checks:

```bash
npm run lint
npm run build
```

Collector commands:

```bash
npm run collector:backfill
npm run collector:live
```

The collector reads credentials from `.env.local`, reuses `data/telegram.session`, and writes `data/liquidations.sqlite`. These files are intentionally ignored by Git.

## Data Sources

The current client uses these public Binance USD-M Futures endpoints:

- REST ticker: `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT`
- REST open interest: `https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT`
- REST premium index and funding: `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT`
- Mark price stream: `wss://fstream.binance.com/ws/btcusdt@markPrice@1s`
- Force-order stream: `wss://fstream.binance.com/ws/btcusdt@forceOrder`

The public force-order stream is an observed-event feed, not a complete record of every liquidation on the exchange. The UI labels it as confirmed public force orders.

The collector also reads these public Telegram channels through a Telegram user session:

- Binance: `@BinanceLiquidations`
- Bybit: `@BybitLiquidations`

Telegram publication time is used as the event timestamp because the feed does not expose a guaranteed exchange event timestamp. Original messages are retained for audit and parser improvements.

## Estimation Model

The estimator in `page.tsx` distributes open interest across four assumed leverage buckets:

| Leverage | Share | Maintenance margin |
| --- | ---: | ---: |
| 10x | 28% | 0.4% |
| 25x | 32% | 0.5% |
| 50x | 24% | 0.6% |
| 100x | 16% | 1.0% |

Approximate levels are calculated as:

- Long liquidation: `mark price * (1 - 1 / leverage + maintenance margin)`
- Short liquidation: `mark price * (1 + 1 / leverage - maintenance margin)`

Heatmap intensity is concentrated around those levels and scaled by current open-interest notional. These assumptions must be versioned and validated before the output is used for serious market analysis.

The leverage buckets are not measured Binance statistics. They are placeholders for the current scenario model and must not be read as the actual percentage of users or open interest at each leverage. The planned replacement and the comparison with free exchange data and paid providers are documented in [RESEARCH.md](RESEARCH.md).

## Important Files

- `src/app/page.tsx` - Current client dashboard, Binance connections, estimator, and UI state.
- `src/app/globals.css` - Dashboard visual system and responsive layout.
- `src/app/layout.tsx` - Root metadata and font setup.
- `AGENTS.md` - Repository-specific Next.js guidance.
- `package.json` - Development and build scripts.
- `scripts/collector/backfill.ts` - Historical Telegram backfill.
- `scripts/collector/live.ts` - Continuous Telegram listener.
- `scripts/collector/parser.ts` - Telegram message parser.
- `scripts/collector/database.ts` - SQLite schema and migrations.
- `deploy/` - Linux systemd deployment template and notes.
- `RESEARCH.md` - Data-source comparison, model design, costs, and implementation plan.

## Next Steps

1. Wait for an Oracle Always Free A1 capacity opening, or choose another free-tier Linux VM. Do not switch to a paid shape without reviewing the cost.
2. Create the VM with a public subnet, ephemeral public IPv4, Ubuntu, and an SSH key.
3. Deploy the project, `.env.local`, and `data/telegram.session` securely to the server.
4. Run `npm run collector:live` under the provided `systemd` service.
5. Add automatic SQLite backups and collector health reporting.
6. Connect the dashboard to historical data with explicit Binance/Bybit source filters.
7. Add historical heatmap replay and only enable ranges with verified coverage.

## Guardrails

- Never present modeled levels as guaranteed liquidation prices.
- Keep confirmed exchange events visually separate from estimates.
- Treat stale or disconnected feeds as stale; do not silently display them as live.
- Do not expose API keys or credentials in client code.
- Do not add automated trading without a separate security and risk review.
