import dotenv from "dotenv";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { openDatabase } from "./database";
import { parseLiquidationMessage } from "./parser";

dotenv.config({ path: ".env.local" });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const phoneNumber = process.env.TELEGRAM_PHONE_NUMBER;
const sessionPath = process.env.TELEGRAM_SESSION_PATH ?? path.resolve("data/telegram.session");
const databasePath = process.env.LIQUIDATION_DATABASE_PATH ?? path.resolve("data/liquidations.sqlite");
const messageLimit = Number(process.env.TELEGRAM_BACKFILL_LIMIT ?? 100_000);
const channels = [
  { exchange: "binance", channel: "BinanceLiquidations" },
  { exchange: "bybit", channel: "BybitLiquidations" },
] as const;

if (!Number.isInteger(apiId) || !apiHash || !phoneNumber) {
  throw new Error("Set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_PHONE_NUMBER in .env.local before running the collector.");
}

const requiredApiHash = apiHash;
const requiredPhoneNumber = phoneNumber;

async function prompt(question: string): Promise<string> {
  const terminal = readline.createInterface({ input, output });
  const answer = await terminal.question(question);
  terminal.close();
  return answer.trim();
}

async function main(): Promise<void> {
  const database = openDatabase(databasePath);
  const sessionValue = process.env.TELEGRAM_SESSION ?? (fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, "utf8").trim() : "");
  const session = new StringSession(sessionValue);
  const client = new TelegramClient(session, apiId, requiredApiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => requiredPhoneNumber,
    password: async () => prompt("Telegram 2FA password (leave blank if disabled): "),
    phoneCode: async () => prompt("Telegram verification code: "),
    onError: (error) => console.error("Telegram login error:", error),
  });

  const savedSession = session.save();
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, savedSession, { encoding: "utf8", mode: 0o600 });
  console.log(`Authenticated. Session saved to ${sessionPath}. Treat it like a password and do not commit it.`);

  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO liquidation_events
      (exchange, symbol, side, event_time, telegram_message_time, price, amount_value, amount_unit, notional_usd, source_channel, source_message_id, raw_message, parser_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFailure = database.prepare(`
    INSERT OR IGNORE INTO parse_failures
      (source_channel, exchange, source_message_id, message_time, raw_message, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const { exchange, channel } of channels) {
    const startedAt = Date.now();
    const run = database.prepare("INSERT INTO ingestion_runs (source_channel, exchange, started_at) VALUES (?, ?, ?)").run(channel, exchange, startedAt);
    let seen = 0;
    let parsed = 0;
    let skipped = 0;
    let oldest: number | undefined;
    let newest: number | undefined;

    console.log(`Backfilling @${channel} (limit ${messageLimit.toLocaleString()})...`);
    try {
      for await (const message of client.iterMessages(channel, { limit: messageLimit, reverse: true })) {
        seen += 1;
        const messageTime = message.date ? message.date * 1_000 : Date.now();
        oldest = oldest === undefined ? messageTime : Math.min(oldest, messageTime);
        newest = newest === undefined ? messageTime : Math.max(newest, messageTime);
        const text = typeof message.message === "string" ? message.message : "";
        const liquidation = parseLiquidationMessage(text);

        if (!liquidation) {
          skipped += 1;
          insertFailure.run(channel, exchange, message.id, messageTime, text, "Message did not match the liquidation format");
          continue;
        }

        parsed += 1;
        insertEvent.run(
          exchange,
          liquidation.symbol,
          liquidation.side,
          messageTime,
          messageTime,
          liquidation.price,
          liquidation.amountValue,
          liquidation.amountUnit,
          liquidation.notionalUsd,
          channel,
          message.id,
          text,
          "telegram-v2",
        );
      }

      database.prepare(`
        UPDATE ingestion_runs
        SET finished_at = ?, messages_seen = ?, messages_parsed = ?, messages_skipped = ?, oldest_message_time = ?, newest_message_time = ?
        WHERE id = ?
      `).run(Date.now(), seen, parsed, skipped, oldest ?? null, newest ?? null, run.lastInsertRowid);
      console.log(`@${channel}: ${parsed.toLocaleString()} parsed, ${skipped.toLocaleString()} skipped, ${seen.toLocaleString()} total.`);
    } catch (error) {
      database.prepare("UPDATE ingestion_runs SET finished_at = ?, error = ? WHERE id = ?").run(Date.now(), String(error), run.lastInsertRowid);
      throw error;
    }
  }

  database.close();
  await client.disconnect();
  console.log(`Database written to ${databasePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});