/**
 * Telegram webhook handler for Vercel (Node runtime).
 * - Webhook: POST /api/bot
 * - Uses Telegram Bot API (webhook) and Google Sheets API v4
 * - Append-only, static menu, idempotent
 *
 * Environment variables:
 * - BOT_TOKEN
 * - SHEET_ID
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL
 * - GOOGLE_PRIVATE_KEY (handle \n correctly)
 * - ADMIN_CHAT_ID (optional)
 *
 * Minimal deps expected:
 *   googleapis, google-auth-library
 */

import {
  tgSendMessage,
  tgEditMessageText,
  tgEditReplyMarkup,
  tgAnswerCallbackQuery,
  tgNotifyAdmin,
} from "../lib/telegram";
import {
  getSheetsAuth,
  ensureSheet,
  appendOrder,
  type OrderRow,
} from "../lib/sheets";
import {
  DRINKS,
  OAT_UPCHARGE,
  fmtMoney,
  buildMainMenu,
  buildOatChoice,
  listText,
  ensureMenuLoadedOnce,
} from "../lib/menu";
import { LRUSet, OnceGuard, keyFromParts } from "../lib/idempotency";

/* =============================
   Config and constants
============================= */

const SHEET_ID = (globalThis as any)?.process?.env?.SHEET_ID || "";

const seenUpdateIds = new LRUSet<number>(1000); // dedupe update_id
const milkPromptOnce = new OnceGuard<string>(1000); // guard to only show oat choices once per message

/* =============================
   Telegram payload types (minimal)
============================= */

type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TgChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TgMessage = {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
};

type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

/* =============================
   Utils
============================= */

const nowIso = () => new Date().toISOString();

async function safeTg<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err: any) {
    console.error(`Telegram API error: ${err?.message || String(err)}`);
    return undefined;
  }
}

/* =============================
   Main webhook handler
============================= */

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const update = await parseUpdate(req);
    if (!update || typeof update.update_id !== "number") {
      res.statusCode = 200;
      res.end("OK");
      return;
    }

    // Idempotency by update_id
    if (seenUpdateIds.has(update.update_id)) {
      res.statusCode = 200;
      res.end("OK");
      return;
    }
    seenUpdateIds.add(update.update_id);

    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    res.statusCode = 200;
    res.end("OK");
  } catch (err: any) {
    console.error(`bot.ts error: ${err?.message || String(err)}`);
    try {
      await tgNotifyAdmin(`⚠ Bot error: ${err?.message || String(err)}`);
    } catch {}
    // Always 200 to stop Telegram retries
    res.statusCode = 200;
    res.end("OK");
  }
}

/* =============================
   Handlers
============================= */

async function handleMessage(msg: TgMessage) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/menu") {
    await ensureMenuLoadedOnce();
    const menu = buildMainMenu();
    await safeTg(() => tgSendMessage(chatId, "Choose a drink:", menu));
    return;
  }

  if (text === "/list") {
    await safeTg(() => tgSendMessage(chatId, listText()));
    return;
  }

  // Ignore other messages
}

async function handleCallback(cb: TgCallbackQuery) {
  await ensureMenuLoadedOnce();
  const data = cb.data || "";
  const msg = cb.message;
  if (!msg) {
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    return;
  }
  await ensureMenuLoadedOnce();
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  if (data.startsWith("D|")) {
    const idx = Number(data.split("|")[1]);
    const drink = DRINKS[idx as number];
    if (!Number.isFinite(idx) || !drink) {
      await safeTg(() => tgAnswerCallbackQuery(cb.id, "Unknown item"));
      return;
    }

    if (!drink.oat) {
      // Append order immediately
      const ok = await tryAppendOrder({
        chatId,
        user: cb.from,
        messageId,
        callbackId: cb.id,
        drinkIdx: idx,
        oat: false,
      });

      if (ok) {
        const final = drink.price;
        const savedText = `Saved: ${drink.name} — ${fmtMoney(final)}`;
        await safeTg(() => tgEditMessageText(chatId, messageId, savedText));
        await safeTg(() =>
          tgEditReplyMarkup(chatId, messageId, { inline_keyboard: [] }),
        );
        await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
      } else {
        await safeTg(() =>
          tgAnswerCallbackQuery(cb.id, "⚠ couldn't save, try again"),
        );
        await safeTg(() =>
          tgSendMessage(chatId, "⚠ couldn't save, try again"),
        );
      }
      return;
    }

    // Oat-eligible: show two options once, by editing the same message
    const onceKey = keyFromParts(chatId, messageId, idx);
    if (!milkPromptOnce.once(onceKey)) {
      await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
      return;
    }

    const choices = buildOatChoice(idx);
    await safeTg(() => tgEditReplyMarkup(chatId, messageId, choices));
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    return;
  }

  if (data.startsWith("C|")) {
    const parts = data.split("|");
    const idx = Number(parts[1]);
    const oatFlag = parts[2] === "1";
    const drink = DRINKS[idx as number];

    if (!Number.isFinite(idx) || !drink) {
      await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
      return;
    }

    const ok = await tryAppendOrder({
      chatId,
      user: cb.from,
      messageId,
      callbackId: cb.id,
      drinkIdx: idx,
      oat: oatFlag,
    });

    if (ok) {
      const base = drink.price;
      const final = oatFlag ? base + OAT_UPCHARGE : base;
      const savedText = oatFlag
        ? `Saved: ${drink.name} with oat milk — ${fmtMoney(base)} + ${fmtMoney(OAT_UPCHARGE)} = ${fmtMoney(final)}`
        : `Saved: ${drink.name} — ${fmtMoney(final)}`;
      await safeTg(() => tgEditMessageText(chatId, messageId, savedText));
      await safeTg(() =>
        tgEditReplyMarkup(chatId, messageId, { inline_keyboard: [] }),
      );
      await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    } else {
      await safeTg(() =>
        tgAnswerCallbackQuery(cb.id, "⚠ couldn't save, try again"),
      );
      await safeTg(() => tgSendMessage(chatId, "⚠ couldn't save, try again"));
    }
    return;
  }

  // Unknown callback
  await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
}

/* =============================
   Order persistence
============================= */

async function tryAppendOrder(params: {
  chatId: number;
  user: TgUser;
  messageId: number;
  callbackId: string;
  drinkIdx: number;
  oat: boolean;
}): Promise<boolean> {
  try {
    const drink = DRINKS[params.drinkIdx];
    if (!drink) throw new Error("Invalid drink index");

    const username = params.user.username ? `@${params.user.username}` : "";
    const fullName = [params.user.first_name, params.user.last_name]
      .filter(Boolean)
      .join(" ");

    const priceFinal = Number(
      (drink.price + (params.oat ? OAT_UPCHARGE : 0)).toFixed(2),
    );

    const row: OrderRow = {
      timestamp: nowIso(),
      chatId: params.chatId,
      userId: params.user.id,
      username,
      fullName,
      drink: params.oat ? `${drink.name} (oat)` : drink.name,
      price: priceFinal,
      qty: 1,
      total: priceFinal,
      oatMilk: params.oat,
      messageId: params.messageId,
      callbackId: params.callbackId,
    };

    if (!SHEET_ID) throw new Error("SHEET_ID is not set");

    const auth = await getSheetsAuth();
    await ensureSheet(auth, SHEET_ID, "Orders");
    await appendOrder(auth, SHEET_ID, "Orders", row);

    return true;
  } catch (err: any) {
    console.error(`appendOrder error: ${err?.message || String(err)}`);
    try {
      await tgNotifyAdmin(`⚠ Sheets error: ${err?.message || String(err)}`);
    } catch {}
    return false;
  }
}

/* =============================
   Request body parsing
============================= */

async function parseUpdate(req: any): Promise<TgUpdate | null> {
  if (req.body && typeof req.body === "object") {
    return req.body as TgUpdate;
  }
  const raw = await readBody(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    req.on("data", (c: any) => chunks.push(c));
    req.on("end", () =>
      resolve(
        chunks
          .map((x: any) =>
            typeof x === "string"
              ? x
              : x && typeof x.toString === "function"
                ? x.toString("utf8")
                : "",
          )
          .join(""),
      ),
    );
    req.on("error", reject);
  });
}
