import dotenv from "dotenv";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { openDatabase } from "./database";
import { parseLiquidationMessage } from "./parser";

dotenv.config({ path: ".env.local" });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const phoneNumber = process.env.TELEGRAM_PHONE_NUMBER;
const sessionPath = process.env.TELEGRAM_SESSION_PATH ?? path.resolve("data/telegram.session");
const databasePath = process.env.LIQUIDATION_DATABASE_PATH ?? path.resolve("data/liquidations.sqlite");
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
    password: async () => prompt("Telegram 2FA password: "),
    phoneCode: async () => prompt("Telegram verification code: "),
    onError: (error) => console.error("Telegram login error:", error),
  });

  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, session.save(), { encoding: "utf8", mode: 0o600 });

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
    client.addEventHandler(
      async (event: NewMessageEvent) => {
        const message = event.message;
        const messageTime = message.date ? message.date * 1_000 : Date.now();
        const text = typeof message.message === "string" ? message.message : "";
        const liquidation = parseLiquidationMessage(text);

        if (!liquidation) {
          insertFailure.run(channel, exchange, message.id, messageTime, text, "Message did not match the liquidation format");
          return;
        }

        const result = insertEvent.run(
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

        if (result.changes > 0) {
          console.log(`[${exchange}] ${new Date(messageTime).toISOString()} ${text}`);
        }
      },
      new NewMessage({ chats: [channel] }),
    );
  }

  console.log(`Live collector connected for ${channels.map(({ channel }) => `@${channel}`).join(" and ")}.`);
  console.log(`Writing events to ${databasePath}`);

  const shutdown = async (): Promise<void> => {
    console.log("Stopping live collector...");
    await client.disconnect();
    database.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
