import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type CollectorDatabase = Database.Database;

export function openDatabase(databasePath: string): CollectorDatabase {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS liquidation_events (
      id INTEGER PRIMARY KEY,
      exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      telegram_message_time INTEGER NOT NULL,
      price REAL NOT NULL,
      amount_value REAL NOT NULL,
      amount_unit TEXT NOT NULL,
      notional_usd REAL,
      source_channel TEXT NOT NULL,
      source_message_id INTEGER NOT NULL,
      raw_message TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      UNIQUE(source_channel, source_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_liquidation_events_symbol_time
      ON liquidation_events(symbol, event_time);

    CREATE INDEX IF NOT EXISTS idx_liquidation_events_exchange_symbol_time
      ON liquidation_events(exchange, symbol, event_time);

    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id INTEGER PRIMARY KEY,
      source_channel TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      messages_seen INTEGER NOT NULL DEFAULT 0,
      messages_parsed INTEGER NOT NULL DEFAULT 0,
      messages_skipped INTEGER NOT NULL DEFAULT 0,
      oldest_message_time INTEGER,
      newest_message_time INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS parse_failures (
      id INTEGER PRIMARY KEY,
      source_channel TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
      source_message_id INTEGER NOT NULL,
      message_time INTEGER NOT NULL,
      raw_message TEXT NOT NULL,
      reason TEXT NOT NULL,
      UNIQUE(source_channel, source_message_id)
    );
  `);

  const columns = database.prepare("PRAGMA table_info(liquidation_events)").all() as Array<{ name: string; notnull: number }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const notionalColumn = columns.find((column) => column.name === "notional_usd");

  if (notionalColumn?.notnull) {
    database.exec("DROP INDEX IF EXISTS idx_liquidation_events_symbol_time");
    database.exec("ALTER TABLE liquidation_events RENAME TO liquidation_events_legacy");
    database.exec(`
      CREATE TABLE liquidation_events (
        id INTEGER PRIMARY KEY,
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        telegram_message_time INTEGER NOT NULL,
        price REAL NOT NULL,
        amount_value REAL NOT NULL,
        amount_unit TEXT NOT NULL,
        notional_usd REAL,
        source_channel TEXT NOT NULL,
        source_message_id INTEGER NOT NULL,
        raw_message TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        UNIQUE(source_channel, source_message_id)
      )
    `);
    const amountValueExpression = columnNames.has("amount_value") ? "COALESCE(amount_value, notional_usd)" : "notional_usd";
    const amountUnitExpression = columnNames.has("amount_unit") ? "COALESCE(amount_unit, 'usd')" : "'usd'";
    database.exec(`
      INSERT INTO liquidation_events
        (id, exchange, symbol, side, event_time, telegram_message_time, price, amount_value, amount_unit, notional_usd, source_channel, source_message_id, raw_message, parser_version)
      SELECT id, exchange, symbol, side, event_time, telegram_message_time, price, ${amountValueExpression}, ${amountUnitExpression}, notional_usd, source_channel, source_message_id, raw_message, parser_version
      FROM liquidation_events_legacy
    `);
    database.exec("DROP TABLE liquidation_events_legacy");
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_liquidation_events_symbol_time
        ON liquidation_events(symbol, event_time)
    `);
  } else {
    if (!columnNames.has("amount_value")) {
      database.exec("ALTER TABLE liquidation_events ADD COLUMN amount_value REAL");
      database.exec("UPDATE liquidation_events SET amount_value = notional_usd WHERE amount_value IS NULL");
    }
    if (!columnNames.has("amount_unit")) {
      database.exec("ALTER TABLE liquidation_events ADD COLUMN amount_unit TEXT");
      database.exec("UPDATE liquidation_events SET amount_unit = 'usd' WHERE amount_unit IS NULL");
    }
  }

  const ingestionColumns = database.prepare("PRAGMA table_info(ingestion_runs)").all() as Array<{ name: string }>;
  if (!ingestionColumns.some((column) => column.name === "exchange")) {
    database.exec("ALTER TABLE ingestion_runs ADD COLUMN exchange TEXT");
    database.exec("UPDATE ingestion_runs SET exchange = CASE WHEN lower(source_channel) LIKE '%bybit%' THEN 'bybit' ELSE 'binance' END WHERE exchange IS NULL");
  }

  const failureColumns = database.prepare("PRAGMA table_info(parse_failures)").all() as Array<{ name: string }>;
  if (!failureColumns.some((column) => column.name === "exchange")) {
    database.exec("ALTER TABLE parse_failures ADD COLUMN exchange TEXT");
    database.exec("UPDATE parse_failures SET exchange = CASE WHEN lower(source_channel) LIKE '%bybit%' THEN 'bybit' ELSE 'binance' END WHERE exchange IS NULL");
  }
  return database;
}