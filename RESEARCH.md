# Liquidation Data Research

This document records the options considered for replacing the current hardcoded leverage estimator.

## Decision in brief

The recommended path is a staged hybrid:

1. Make observed liquidation activity the primary heatmap. Use the Binance and Bybit public streams and the Telegram collector already in this repository.
2. Add a transparent, optional statistical scenario model after enough local history has accumulated. Calibrate it against observed liquidation events rather than choosing fixed leverage shares by hand.
3. Treat CoinGlass as a possible paid comparison or later data provider, not as the initial dependency.

This gives the project a useful zero-cost product while keeping modeled output clearly labeled as inference.

## Option 1: Exchange and public position data

### What is available for free

Major exchanges provide useful aggregate and event data:

- Binance USD-M Futures: mark price, open interest, funding, public force-order stream, global long/short account ratios, and top-trader account/position ratios.
- Bybit V5: historical open interest by interval and public market streams, with exchange-specific liquidation coverage to be verified during implementation.
- Public trade, price, funding, and open-interest data from other exchanges can extend the same collector pattern.
- Some venues expose public wallet or position information for selected accounts. This is not equivalent to the complete position book and should not be presented as exchange-wide coverage.

### What is not available publicly

The exchanges do not provide a public, exchange-wide table containing every account's:

- Entry price
- Position size
- Leverage
- Margin mode and margin balance
- Maintenance tier
- Liquidation price

Authenticated position endpoints expose the requesting user's own positions. They cannot be used to reconstruct all users' positions. Aggregate open interest also does not reveal the price distribution of those positions.

### Concrete implementation

Build an `observed` data layer with these tables or event types:

- `price_snapshots`: exchange, symbol, timestamp, mark price, index price
- `open_interest_snapshots`: exchange, symbol, timestamp, contracts, USD notional
- `funding_snapshots`: exchange, symbol, timestamp, funding rate
- `liquidation_events`: existing normalized table, with source and raw message
- `position_ratio_snapshots`: exchange, symbol, timestamp, account ratio, position ratio, top-trader ratios where available

Render only measured liquidation events in the primary heatmap. Aggregate by price bins and time bins, preserving source exchange and an explicit coverage label. Keep open interest, funding, and long/short ratios as separate context series rather than converting them into liquidation dollars.

### Cost and realism

| Factor | Assessment |
| --- | --- |
| API/data cost | $0 for public endpoints, subject to exchange limits and terms |
| Engineering cost | Low to medium |
| Coverage | Incomplete by definition; public liquidation feeds are not the full position book |
| Reliability | High for the events actually received; low for unseen positions |
| Best use | Primary product and historical database |

This is the most realistic starting point for this project because the collector and SQLite schema already exist.

## Option 2: Proprietary heatmap provider

### What CoinGlass publicly documents

CoinGlass API V4 has pair liquidation heatmap endpoints for Model 1, Model 2, and Model 3. The documented response includes:

- Price-axis levels
- A matrix-like `liquidation_leverage_data` payload containing x index, y index, and value
- Price candlesticks
- Ranges from 12 hours through 1 year

The documentation describes these as levels calculated from market data and liquidation leverage levels. It does not publish the complete input dataset, the exact leverage distribution, the position-entry-price assumptions, or the formulas that distinguish the three models. Therefore, the result should be treated as a provider estimate, not direct exchange truth.

### Access and cost

The documented heatmap endpoints require an API plan. CoinGlass currently lists the API Hobbyist plan at $29/month when billed monthly, with higher plans at $79/month and above. The heatmap endpoint documentation marks it as available only on paid plan columns.

The public CoinGlass website may display a chart to a human user, but scraping the website is not a dependable API strategy. It is brittle, may violate terms, and can break without notice. There is no documented free endpoint that returns the heatmap matrix directly.

### Concrete implementation if purchased

1. Put the API key on the server only, never in browser code.
2. Add a server route or collector job that requests the selected exchange, symbol, and range.
3. Cache responses in SQLite with provider, model, request parameters, retrieval time, and raw JSON.
4. Normalize `y_axis` and `liquidation_leverage_data` into the dashboard grid.
5. Display `SOURCE: COINGLASS MODEL N` and the retrieval timestamp.
6. Compare provider values against the observed Binance/Bybit events before presenting both layers together.
7. Add a usage budget and fail closed when the API quota or subscription ends.

### Cost and realism

| Factor | Assessment |
| --- | --- |
| API/data cost | At least the current paid Hobbyist plan for the documented heatmap endpoint |
| Engineering cost | Low to medium |
| Coverage | Broad, including historical ranges and multiple exchanges, subject to plan |
| Reliability | Operationally convenient; methodology remains partly opaque |
| Best use | Paid comparison layer or production shortcut |

This is the quickest way to obtain a polished multi-exchange heatmap, but it conflicts with the current zero-cost goal.

## Option 3: Statistically calibrated model

This approach does not claim to recover the true hidden positions. It estimates a probability distribution of liquidation pressure from observable data and reports uncertainty.

### Model target

For each time `t`, price level `p`, side `s`, and forecast horizon `h`, estimate:

```text
expected liquidation pressure(t, p, s, h)
```

and a confidence or calibration interval. The output should be phrased as expected pressure, not guaranteed liquidation notional.

### Latent position representation

Represent the hidden book as a distribution of position distance from the current price or entry return:

```text
latent positions = {side, entry-distance, size, effective leverage, age}
```

Use a small number of interpretable latent components rather than pretending to know every account. For example:

- Low leverage / wide liquidation distance
- Medium leverage / medium distance
- High leverage / close distance

The component weights and distance distributions are parameters learned from history. They are not fixed constants in source code.

### Observable inputs

- Mark and index price returns
- Open-interest level and change
- Funding rate and change
- Volume and volatility
- Public liquidation-event counts and notional by side and price distance
- Exchange and source indicators
- Long/short account and top-trader ratios where available
- Time of day and major volatility regime

### A practical first model

Start with a discretized hazard model:

1. Divide price distance into bins, for example 0.25%, 0.5%, 1%, 2%, 5%, and wider.
2. For every historical interval, record the features above and the liquidation events that occur in the following horizon.
3. Fit a regularized Poisson or negative-binomial model for event count and a separate model for event notional.
4. Use separate long and short targets.
5. Add exchange-specific effects and a time-decay factor so old observations matter less when market structure changes.
6. Convert predicted probability and expected notional into a heatmap. Keep the interval or confidence score visible.

An interpretable form is:

```text
log(expected_count[p, side]) =
  intercept[p, side]
  + beta_oi * standardized(OI)
  + beta_delta_oi * standardized(change in OI)
  + beta_vol * volatility
  + beta_funding * funding
  + beta_ratio * long_short_features
  + exchange_effect
```

The model can later be upgraded to a mixture model or survival model if the data supports it. A neural network is not justified initially because the hidden target is incomplete and regime shifts are severe.

### Calibration and validation

Use walk-forward validation, never random train/test splits. Evaluate:

- Precision of high-risk price bins
- Recall of observed liquidation clusters
- Calibration of predicted probabilities
- Poisson or negative-binomial deviance
- Error by exchange, side, volatility regime, and horizon
- A baseline using only recent observed liquidation density

The model must be allowed to say `insufficient coverage`. If a price range has little historical support, the UI should show a wide uncertainty band or no estimate.

### Cost and realism

| Factor | Assessment |
| --- | --- |
| API/data cost | $0 with existing public feeds and local server storage |
| Engineering cost | Medium to high |
| Coverage | Still limited by public event coverage |
| Reliability | Potentially useful if calibrated; never exact position truth |
| Best use | Research layer and transparent scenario analysis |

This is the strongest long-term research direction, but it should come after the observed data layer has accumulated a stable, continuously collected dataset.

## Comparison

| Option | Up-front cost | Time to useful result | Main weakness | Recommendation |
| --- | ---: | ---: | --- | --- |
| Exchange/public observed data | Free | Short | Does not show hidden positions | Build first |
| CoinGlass provider | $29/month minimum based on current listed plan | Short | Paid and partly opaque methodology | Optional comparison |
| Statistical calibration | Free infrastructure, high engineering time | Medium to long | Learns from incomplete outcomes | Build after observation history |

## Final project plan

### Phase 1: Make the product honest and useful

- Remove synthetic `visiblePulse` heatmap texture.
- Remove derived per-cell notional labels or rename them as intensity only.
- Make observed liquidation events the primary heatmap layer.
- Show source, event count, notional coverage, last event, and stale-feed state.
- Keep the current leverage estimator behind an explicit `Scenario` mode.

### Phase 2: Improve the free data foundation

- Keep the Telegram listener running on the free server when Oracle capacity is available.
- Add direct Binance and Bybit market snapshots to SQLite.
- Add Bybit public liquidation ingestion after endpoint behavior is verified.
- Add backup and cursor/health persistence.

### Phase 3: Add calibration

- Build a reproducible feature-generation job from SQLite.
- Establish a recent-liquidation-density baseline.
- Fit and walk-forward-test the interpretable hazard model.
- Show confidence and coverage alongside predictions.

### Phase 4: Reassess paid data

- Run the same periods through CoinGlass if a subscription is affordable.
- Compare CoinGlass heatmap clusters with observed events and the calibrated model.
- Subscribe only if the improvement is material enough to justify the recurring cost.

## Sources checked

- [Binance Futures developer documentation](https://developers.binance.com/docs/derivatives/usds-margined-futures)
- [Bybit V5 Open Interest](https://bybit-exchange.github.io/docs/v5/market/open-interest)
- [CoinGlass API introduction](https://docs.coinglass.com/reference/getting-started-with-your-api)
- [CoinGlass Pair Liquidation Heatmap Model 1](https://docs.coinglass.com/reference/liquidation-heatmap)
- [CoinGlass Pair Liquidation Heatmap Model 2](https://docs.coinglass.com/reference/liquidation-heatmap-model2)
- [CoinGlass Pair Liquidation Heatmap Model 3](https://docs.coinglass.com/reference/liquidation-heatmap-model3)
- [CoinGlass API pricing](https://www.coinglass.com/pricing)
