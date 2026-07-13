# Project Status

This is the current project handoff status.

## Working now

- Next.js TypeScript dashboard with live Binance price, open interest, funding, and force-order data.
- Functional short timeframes, zoom controls, and explicit unavailable states for unsupported long ranges.
- Telegram authentication through GramJS using a local user session.
- Historical backfill command:

```bash
npm run collector:backfill
```

- Continuous listener command:

```bash
npm run collector:live
```

- SQLite database at `data/liquidations.sqlite`.
- Telegram session at `data/telegram.session`.
- Both local data files are ignored by Git.

## Updated product direction

The current leverage estimator is not treated as a factual map of trader positions. The primary product direction is now:

- Observed Binance and Bybit liquidation events as the main heatmap layer.
- Open interest, funding, price, and long/short ratios as separate measured context.
- The leverage model retained only as an explicitly labeled scenario view.
- A later statistically calibrated model, trained against the collected event history and required to show coverage and uncertainty.

The three investigated paths and their cost and implementation tradeoffs are documented in [RESEARCH.md](RESEARCH.md). The recommended order is free observed data first, calibrated inference second, and CoinGlass only as an optional paid comparison.

## Collected data

The 100,000-message backfill produced:

- Binance: 99,399 parsed events, with coverage approximately from March 2020 through December 2021.
- Bybit: 99,893 parsed events, with coverage approximately from November 2022 through January 2025.

Binance and Bybit are stored separately. Overlapping timestamps do not deduplicate across exchanges. USD amounts and contract amounts are also stored separately; contract amounts are not converted into invented USD values.

## Current blocker

Oracle Cloud instance creation failed because `VM.Standard.A1.Flex` was out of capacity in availability domain `AD-1`. The configuration was otherwise prepared with Ubuntu, 1 OCPU, 6 GB memory, 50 GB boot volume, a public subnet, and an ephemeral public IPv4 address. The user saved the configuration as an Oracle stack and will retry when A1 capacity becomes available.

Do not create a paid shape just to bypass the capacity error. Verify the final Oracle cost summary before creating any instance.

## Resume checklist

1. Retry the saved Oracle stack in another availability domain, leaving fault domain selection automatic.
2. Confirm the subnet is public and has a route from `0.0.0.0/0` to an Internet Gateway.
3. Confirm the final instance summary is within the Always Free allowance.
4. SSH to the VM using the private key kept locally.
5. Install Node.js, build tools, and project dependencies.
6. Transfer `.env.local` and `data/telegram.session` securely. Never commit either file.
7. Install `deploy/liquidation-collector.service.example` as a systemd service.
8. Verify logs with `journalctl` and add a database backup routine.
9. Connect the dashboard to the exchange-separated SQLite data as the observed primary layer.
10. Replace synthetic heatmap intensity with observed price/time bins.
11. Move the leverage estimator behind an explicit scenario control.
12. Build and validate the statistical hazard model described in [RESEARCH.md](RESEARCH.md).

## Validation

The latest checks passed:

```bash
npm run lint
npm run build
```