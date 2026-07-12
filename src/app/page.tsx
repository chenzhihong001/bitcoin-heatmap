"use client";

import { useEffect, useMemo, useState } from "react";

const timeframeOptions = ["15M", "1H", "4H", "12H", "1D", "1W", "1M", "3M", "6M", "1Y"] as const;
type Timeframe = (typeof timeframeOptions)[number];
const timeframeSettings: Record<Timeframe, { columns: number; stepMinutes: number; priceStep: number }> = {
  "15M": { columns: 12, stepMinutes: 1, priceStep: 100 },
  "1H": { columns: 18, stepMinutes: 5, priceStep: 200 },
  "4H": { columns: 18, stepMinutes: 20, priceStep: 300 },
  "12H": { columns: 18, stepMinutes: 60, priceStep: 400 },
  "1D": { columns: 24, stepMinutes: 60, priceStep: 500 },
  "1W": { columns: 28, stepMinutes: 360, priceStep: 700 },
  "1M": { columns: 31, stepMinutes: 1440, priceStep: 900 },
  "3M": { columns: 30, stepMinutes: 4320, priceStep: 1200 },
  "6M": { columns: 26, stepMinutes: 10080, priceStep: 1500 },
  "1Y": { columns: 26, stepMinutes: 20160, priceStep: 2200 },
};
const leverageBuckets = [
  { leverage: 10, share: 0.28, maintenance: 0.004 },
  { leverage: 25, share: 0.32, maintenance: 0.005 },
  { leverage: 50, share: 0.24, maintenance: 0.006 },
  { leverage: 100, share: 0.16, maintenance: 0.01 },
];
type LiquidationEvent = { side: string; price: number; notional: number; time: string };

function buildHeatmap(markPrice: number, openInterestContracts: number | null, columnCount: number, priceStep: number, zoomLevel: number) {
  const notional = (openInterestContracts ?? 100_000) * markPrice;
  const levels = leverageBuckets.flatMap(({ leverage, share, maintenance }) => [
    { price: markPrice * (1 - 1 / leverage + maintenance), weight: share, side: "long" },
    { price: markPrice * (1 + 1 / leverage - maintenance), weight: share, side: "short" },
  ]);
  const visiblePriceStep = priceStep * zoomLevel;
  const priceLevels = Array.from({ length: 12 }, (_, row) => Math.round(markPrice + (5.5 - row) * visiblePriceStep));
  return priceLevels.map((price, row) => Array.from({ length: columnCount }, (_, column) => {
    const timeWeight = 0.52 + column / (columnCount * 2.2);
    const concentration = levels.reduce((total, level) => {
      const distance = Math.abs(price - level.price) / markPrice;
      return total + level.weight * Math.exp(-distance * distance / 0.00018);
    }, 0);
    const notionalWeight = Math.min(1, concentration * (notional / 6_000_000_000));
    const visiblePulse = ((row * 7 + column * 11) % 17) / 180;
    return Math.min(0.98, notionalWeight * timeWeight + visiblePulse);
  }));
}

function heatColor(intensity: number) {
  if (intensity > 0.72) return `rgba(239, 111, 80, ${0.36 + intensity * 0.58})`;
  if (intensity > 0.42) return `rgba(237, 177, 70, ${0.18 + intensity * 0.54})`;
  return `rgba(55, 121, 125, ${0.08 + intensity * 0.58})`;
}

export default function Home() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1H");
  const [isLive, setIsLive] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [selected, setSelected] = useState({ row: 2, column: 6 });
  const [markPrice, setMarkPrice] = useState(63700);
  const [priceChange, setPriceChange] = useState(0);
  const [lastUpdate, setLastUpdate] = useState("--:--:--");
  const [feedStatus, setFeedStatus] = useState("CONNECTING");
  const [openInterestContracts, setOpenInterestContracts] = useState<number | null>(null);
  const [fundingRate, setFundingRate] = useState<number | null>(null);
  const [observedLiquidations, setObservedLiquidations] = useState(0);
  const [lastLiquidation, setLastLiquidation] = useState("--:--:--");
  const [recentEvents, setRecentEvents] = useState<LiquidationEvent[]>([]);
  const timeframeSetting = timeframeSettings[timeframe];
  const historicalUnavailable = ["1M", "3M", "6M", "1Y"].includes(timeframe);
  const timeLabels = useMemo(() => Array.from({ length: timeframeSetting.columns }, (_, index) => {
    const minutes = index * timeframeSetting.stepMinutes;
    if (minutes >= 1440) return `D${Math.floor(minutes / 1440) + 1}`;
    const hours = Math.floor(minutes / 60).toString().padStart(2, "0");
    const remainder = (minutes % 60).toString().padStart(2, "0");
    return `${hours}:${remainder}`;
  }), [timeframeSetting]);
  const prices = useMemo(() => Array.from({ length: 12 }, (_, row) => Math.round(markPrice + (5.5 - row) * timeframeSetting.priceStep * zoomLevel)), [markPrice, timeframeSetting, zoomLevel]);
  const heatmap = useMemo(() => buildHeatmap(markPrice, openInterestContracts, timeframeSetting.columns, timeframeSetting.priceStep, zoomLevel), [markPrice, openInterestContracts, timeframeSetting, zoomLevel]);
  const selectedColumn = Math.min(selected.column, timeframeSetting.columns - 1);
  const selectedIntensity = heatmap[selected.row][selectedColumn];
  const selectedNotional = useMemo(() => `$${(selectedIntensity * 48 + 8.4).toFixed(1)}M`, [selectedIntensity]);

  useEffect(() => {
    if (!isLive) {
      return;
    }
    let cancelled = false;

    const loadTicker = () => fetch("https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT")
      .then((response) => response.json())
      .then((ticker: { lastPrice?: string; priceChangePercent?: string }) => {
        if (cancelled || !ticker.lastPrice) return;
        setMarkPrice(Number(ticker.lastPrice));
        setPriceChange(Number(ticker.priceChangePercent ?? 0));
        setLastUpdate(new Date().toISOString().slice(11, 19));
      })
      .catch(() => setFeedStatus("DEGRADED"));
    void loadTicker();
    const refresh = window.setInterval(loadTicker, 5_000);

    const socket = new WebSocket("wss://fstream.binance.com/ws/btcusdt@markPrice@1s");
    socket.onopen = () => setFeedStatus("NOMINAL");
    socket.onmessage = (event) => {
      const update = JSON.parse(event.data) as { p?: string; E?: number };
      if (!update.p) return;
      setMarkPrice(Number(update.p));
      setLastUpdate(new Date(update.E ?? Date.now()).toISOString().slice(11, 19));
    };
    socket.onerror = () => setFeedStatus("DEGRADED");
    socket.onclose = () => { if (!cancelled) setFeedStatus("DISCONNECTED"); };

    return () => { cancelled = true; window.clearInterval(refresh); socket.close(); };
  }, [isLive]);

  useEffect(() => {
    let cancelled = false;
    const loadDerivativesData = async () => {
      try {
        const [interestResponse, fundingResponse] = await Promise.all([
          fetch("https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT"),
          fetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT"),
        ]);
        const interest = await interestResponse.json() as { openInterest?: string };
        const funding = await fundingResponse.json() as { lastFundingRate?: string };
        if (cancelled) return;
        if (interest.openInterest) setOpenInterestContracts(Number(interest.openInterest));
        if (funding.lastFundingRate) setFundingRate(Number(funding.lastFundingRate) * 100);
      } catch {
        if (!cancelled) setFeedStatus("DEGRADED");
      }
    };
    void loadDerivativesData();
    const refresh = window.setInterval(loadDerivativesData, 30_000);
    return () => { cancelled = true; window.clearInterval(refresh); };
  }, []);

  useEffect(() => {
    if (!isLive) return;
    const socket = new WebSocket("wss://fstream.binance.com/ws/btcusdt@forceOrder");
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data) as { o?: { q?: string; ap?: string; T?: number } };
      const order = payload.o;
      if (!order?.q || !order.ap) return;
      const eventTime = new Date(order.T ?? Date.now()).toISOString().slice(11, 19);
      const liquidationEvent = { side: "LIQ", price: Number(order.ap), notional: Number(order.q) * Number(order.ap), time: eventTime };
      setObservedLiquidations((total) => total + liquidationEvent.notional);
      setLastLiquidation(eventTime);
      setRecentEvents((events) => [liquidationEvent, ...events].slice(0, 4));
    });
    return () => socket.close();
  }, [isLive]);

  const formattedPrice = `$${markPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const formattedOpenInterest = openInterestContracts === null ? "LOADING" : `$${(openInterestContracts * markPrice / 1_000_000_000).toFixed(2)}B`;
  const formattedFundingRate = fundingRate === null ? "LOADING" : `${fundingRate >= 0 ? "+" : ""}${fundingRate.toFixed(4)}%`;
  const formattedLiquidations = observedLiquidations === 0 ? "NONE YET" : `$${(observedLiquidations / 1_000_000).toFixed(2)}M`;
  const displayedFeedStatus = isLive ? feedStatus : "PAUSED";
  const currentPricePosition = `${((prices[0] - markPrice) / (prices[0] - prices[prices.length - 1])) * 100}%`;
  const selectedSide = prices[selected.row] >= markPrice ? "SHORT" : "LONG";

  return (
    <main className="dashboard-shell">
      <nav className="topbar"><div className="brand-lockup"><span className="brand-mark">L</span><span>LIQUID / MAP</span><span className="brand-version">BETA</span></div><div className="topbar-meta"><span className="status-dot" /> Binance Futures <span className="muted">|</span> BTCUSDT Perpetual</div><button className={`live-button ${isLive ? "is-live" : ""}`} onClick={() => setIsLive(!isLive)}><span className="live-pulse" /> {isLive ? "LIVE" : "PAUSED"}</button></nav>
      <section className="page-heading"><div><p className="eyebrow">MARKET STRUCTURE / REAL-TIME</p><h1>Liquidation <em>heatmap</em></h1><p className="heading-copy">Estimated forced-flow concentrations for BTC perpetual futures.</p></div><div className="heading-stats"><div><span className="stat-label">MARK PRICE</span><strong>{formattedPrice}</strong><span className={priceChange >= 0 ? "positive" : "negative"}>{priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%</span></div><div><span className="stat-label">UPDATED</span><strong>{lastUpdate}</strong><span className="muted">UTC</span></div></div></section>
      <section className="control-strip"><div className="segmented-control">{timeframeOptions.map((option) => <button key={option} className={timeframe === option ? "active" : ""} onClick={() => setTimeframe(option)}>{option}</button>)}</div><span className="control-divider" /><button className="filter-button active-filter">BOTH <span>LONG / SHORT</span></button><button className="filter-button">ALL NOTIONAL <span>USD</span></button><div className="controls-spacer" /><div className="zoom-controls"><button aria-label="Zoom out price range" onClick={() => setZoomLevel((level) => Math.min(5, level + 1))}>-</button><span>{zoomLevel === 1 ? "1x" : `${zoomLevel}x RANGE`}</span><button aria-label="Zoom in price range" onClick={() => setZoomLevel((level) => Math.max(1, level - 1))}>+</button></div><span className="model-note">MODEL 0.3.1 <span className="info-icon">i</span></span></section>
      <section className="workspace-grid"><div className="chart-panel"><div className="panel-header"><div><span className="panel-kicker">BTCUSDT / {timeframe}</span><span className="panel-title">Estimated liquidation concentration</span></div><div className="legend"><span><i className="legend-low" /> LOW</span><span><i className="legend-mid" /> ELEVATED</span><span><i className="legend-high" /> HIGH</span></div></div><div className="heatmap-wrap"><div className="price-axis">{prices.map((price) => <span key={price}>${(price / 1000).toFixed(1)}k</span>)}</div><div className="heatmap-area" onWheel={(event) => setZoomLevel((level) => Math.max(1, Math.min(5, level + (event.deltaY > 0 ? 1 : -1))))}><div className="grid-lines">{prices.map((price) => <span key={price} />)}</div>{historicalUnavailable ? <div className="data-unavailable"><strong>HISTORICAL HEATMAP UNAVAILABLE</strong><span>Binance public liquidation events are live-only. This range needs stored history or a licensed historical provider.</span><small>SELECT 15M - 1W FOR LIVE MODELED DATA</small></div> : <><div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${timeframeSetting.columns}, minmax(1.2rem, 1fr))`, width: timeframeSetting.columns > 20 ? `${timeframeSetting.columns * 2.1}rem` : "100%" }}>{heatmap.map((line, row) => line.map((intensity, column) => <button aria-label={`Estimated liquidation at $${prices[row].toLocaleString()}`} key={`${row}-${column}`} className={`heat-cell ${selected.row === row && selected.column === column ? "selected" : ""}`} style={{ backgroundColor: heatColor(intensity) }} onClick={() => setSelected({ row, column })} />))}</div><div className="current-price-line" style={{ top: currentPricePosition }}><span>{formattedPrice}</span></div><div className="cluster-label cluster-top">SHORTS AT RISK <strong>MODELED</strong></div><div className="cluster-label cluster-bottom">LONGS AT RISK <strong>MODELED</strong></div></>}<div className="time-axis">{timeLabels.filter((_, index) => index % Math.max(1, Math.floor(timeLabels.length / 6)) === 0).map((time) => <span key={time}>{time}</span>)}</div></div></div><div className="chart-footer"><span>PRICE LEVELS / USD</span><span>{historicalUnavailable ? "NO RELIABLE HISTORICAL SOURCE" : `${timeframe} live modeled viewport`}</span><span>SCROLL TO ZOOM</span></div></div><aside className="inspector-panel"><div className="panel-header"><span className="panel-kicker">INSPECTOR</span><span className="live-label">● {displayedFeedStatus}</span></div><div className="inspector-price"><span>SELECTED LEVEL</span><strong>${prices[selected.row].toLocaleString()}.00</strong><span className={selectedSide === "SHORT" ? "positive" : "negative"}>{selectedSide} LIQUIDATIONS</span></div><div className="inspector-block"><span className="stat-label">ESTIMATED NOTIONAL</span><strong className="big-number">{historicalUnavailable ? "N/A" : selectedNotional}</strong><div className="meter"><span style={{ width: historicalUnavailable ? "0%" : `${Math.max(18, selectedIntensity * 100)}%` }} /></div><div className="meter-labels"><span>LOW</span><span>HIGH</span></div></div><div className="detail-list"><div><span>LEVERAGE BAND</span><strong>{historicalUnavailable ? "HISTORICAL N/A" : "ASSUMPTION / 10x - 100x"}</strong></div><div><span>OPEN INTEREST</span><strong>{formattedOpenInterest}</strong></div><div><span>FUNDING / 8H</span><strong className={fundingRate !== null && fundingRate < 0 ? "negative" : "positive"}>{formattedFundingRate}</strong></div><div><span>LAST OBSERVED EVENT</span><strong>{lastLiquidation}</strong></div></div><div className="observed-events"><div className="events-heading"><span className="stat-label">CONFIRMED FORCE ORDERS</span><span>BINANCE STREAM</span></div>{recentEvents.length === 0 ? <p className="empty-events">Waiting for a public liquidation event.</p> : recentEvents.map((event, index) => <div className="event-row" key={`${event.time}-${index}`}><span>{event.time}</span><strong>${event.price.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><span>${(event.notional / 1_000_000).toFixed(2)}M</span></div>)}</div><div className="inspector-callout"><span className="callout-icon">!</span><p>Modeled levels are estimates based on open interest, leverage buckets, and maintenance-margin assumptions. They are not guaranteed liquidation prices.</p></div></aside></section>
      <section className="bottom-grid"><div className="metric-card"><span className="stat-label">OPEN INTEREST</span><strong>{formattedOpenInterest}</strong><span className="muted">BINANCE REST SNAPSHOT</span></div><div className="metric-card"><span className="stat-label">FUNDING RATE</span><strong className={fundingRate !== null && fundingRate < 0 ? "negative" : "positive"}>{formattedFundingRate}</strong><span className="muted">CURRENT 8H RATE</span></div><div className="metric-card"><span className="stat-label">OBSERVED LIQUIDATIONS</span><strong>{formattedLiquidations}</strong><span className="muted">SINCE PAGE LOAD / {lastLiquidation}</span></div><div className="metric-card feed-card"><span className="stat-label">FEED HEALTH</span><strong><span className="status-dot" /> {displayedFeedStatus}</strong><span className="muted">BINANCE LIVE STREAMS</span></div></section>
      <footer className="site-footer"><span>DATA: BINANCE USDⓈ-M FUTURES</span><span>ESTIMATES ONLY / NOT FINANCIAL ADVICE</span><span>© 2026 LIQUID / MAP</span></footer>
    </main>
  );
}
