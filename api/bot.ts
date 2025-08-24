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
  getSheetId,
  deleteRow,
} from "../lib/sheets";
import {
  DRINKS,
  OAT_UPCHARGE,
  fmtMoney,
  buildMainMenu,
  buildOatChoice,
  listText,
  ensureMenuLoadedOnce,
  buildConfirmKeyboard,
} from "../lib/menu";
import { LRUSet, OnceGuard, keyFromParts } from "../lib/idempotency";

/* =============================
   Config and constants
============================= */

const SHEET_ID = (globalThis as any)?.process?.env?.SHEET_ID || "";

const seenUpdateIds = new LRUSet<number>(1000); // dedupe update_id
const milkPromptOnce = new OnceGuard<string>(1000); // guard to only show oat choices once per message
const lastRowByChat = new Map<string, number>(); // key: chatId:userId -> last appended row (1-based)

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

  if (text === "/undo") {
    const key = keyFromParts(chatId, msg.from?.id ?? 0);
    const last = lastRowByChat.get(key);
    if (!last) {
      await safeTg(() => tgSendMessage(chatId, "No recent order to undo."));
      return;
    }
    try {
      if (!SHEET_ID) throw new Error("SHEET_ID is not set");
      const auth = await getSheetsAuth();
      const sheetId = await getSheetId(auth, SHEET_ID, "Orders");
      if (sheetId == null) throw new Error("Orders sheet not found");
      await deleteRow(auth, SHEET_ID, sheetId, last);
      lastRowByChat.delete(key);
      await safeTg(() => tgSendMessage(chatId, "Undid your last order."));
    } catch (e: any) {
      console.error(`undo error: ${e?.message || String(e)}`);
      await safeTg(() => tgSendMessage(chatId, "⚠ couldn't undo, try again"));
    }
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
      // Show confirmation keyboard for non-oat drink (with explicit text)
      const confirm = buildConfirmKeyboard(idx, false);
      const confirmText = `Confirm: ${drink.name} — ${fmtMoney(drink.price)}`;
      await safeTg(() => tgEditMessageText(chatId, messageId, confirmText));
      await safeTg(() => tgEditReplyMarkup(chatId, messageId, confirm));
      await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
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

    // Show confirmation keyboard for chosen oat option (regular or with oat) with explicit text
    const confirm = buildConfirmKeyboard(idx, oatFlag);
    const base = drink.price;
    const final = oatFlag ? base + OAT_UPCHARGE : base;
    const confirmText = oatFlag
      ? `Confirm: ${drink.name} with oat milk — ${fmtMoney(base)} + ${fmtMoney(OAT_UPCHARGE)} = ${fmtMoney(final)}`
      : `Confirm: ${drink.name} — ${fmtMoney(final)}`;
    await safeTg(() => tgEditMessageText(chatId, messageId, confirmText));
    await safeTg(() => tgEditReplyMarkup(chatId, messageId, confirm));
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    return;
  }

  // Handle final confirmation: Y|<idx>|<oatFlag>
  if (data.startsWith("Y|")) {
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

  // Handle cancel: N|<idx> — restore drinks menu and allow future milk prompt
  if (data.startsWith("N|")) {
    const parts = data.split("|");
    const idx = Number(parts[1]);
    // Clear once-guard so milk choices can be shown again later for this message
    milkPromptOnce.delete(keyFromParts(chatId, messageId, idx));
    const menu = buildMainMenu();
    await safeTg(() => tgEditMessageText(chatId, messageId, "Choose a drink:"));
    await safeTg(() => tgEditReplyMarkup(chatId, messageId, menu));
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
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
    const appendedRow = await appendOrderAndReturnRow(
      auth,
      SHEET_ID,
      "Orders",
      row,
    );
    if (appendedRow > 0) {
      const key = keyFromParts(params.chatId, params.user.id);
      lastRowByChat.set(key, appendedRow);
    }

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
   Append + row-number helpers (for /undo)
============================= */

function parseAppendedRowNumberFromRange(updatedRange?: string): number {
  if (!updatedRange) return -1;
  const m = updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)/i);
  if (m && m[2]) return parseInt(m[2], 10);
  const nums = updatedRange.match(/(\d+)/g);
  if (nums && nums.length) return parseInt(nums[nums.length - 1], 10);
  return -1;
}

async function appendOrderAndReturnRow(
  auth: any,
  spreadsheetId: string,
  title: string,
  row: OrderRow,
): Promise<number> {
  const res = await auth.sheets.spreadsheets.values.append(
    {
      spreadsheetId,
      range: `${title}!A1:L1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          [
            row.timestamp,
            row.chatId,
            row.userId,
            row.username,
            row.fullName,
            row.drink,
            row.price,
            row.qty,
            row.total,
            row.oatMilk,
            row.messageId,
            row.callbackId,
          ],
        ],
      },
    },
    { timeout: 8000 },
  );
  const updatedRange =
    res && res.data && res.data.updates && res.data.updates.updatedRange;
  return parseAppendedRowNumberFromRange(updatedRange as string | undefined);
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
