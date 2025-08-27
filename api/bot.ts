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
  tgDeleteMessage,
  tgNotifyAdmin,
  tgSetMyCommands,
  tgDeleteMyCommands,
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
  BYOC_DISCOUNT,
  fmtMoney,
  buildMainMenu,
  buildOatChoice,
  buildByocChoice,
  listText,
  ensureMenuLoadedOnce,
  buildConfirmKeyboard,
} from "../lib/menu";
import { LRUSet, OnceGuard, keyFromParts } from "../lib/idempotency";

/* =============================
   Config and constants
============================= */

const SHEET_ID = (globalThis as any)?.process?.env?.SHEET_ID || "";
const PAY_URL = (globalThis as any)?.process?.env?.PAY_URL || "";
const DEFAULT_COMMANDS = [
  { command: "menu", description: "View menu" },
  { command: "pay", description: "Pay for drinks" },
];
const APPROVED_EXTRA_COMMANDS = [
  { command: "log", description: "Log an order" },
  { command: "undo", description: "Undo previous order" },
];
let __defaultCommandsSet = false;

const seenUpdateIds = new LRUSet<number>(1000); // dedupe update_id
const milkPromptOnce = new OnceGuard<string>(1000); // guard to only show oat choices once per message
const lastRowByChat = new Map<string, number>(); // key: chatId:userId -> last appended row (1-based)
const lastOrderDetailsByChat = new Map<
  string,
  { drinkName: string; oatMilk: boolean; byoc: boolean; qty: number }
>();
const pendingQtyByMessage = new Map<string, number>();
const qtyPadByUser = new Map<
  string,
  {
    messageId: number;
    idx: number;
    oat: boolean;
    byoc: boolean;
    buffer: string;
  }
>();

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

const nowIso = () => {
  // Return Singapore time (UTC+08:00) in ISO-like format without milliseconds
  const now = new Date();
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000); // shift to UTC+8
  const y = sgt.getUTCFullYear();
  const m = String(sgt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(sgt.getUTCDate()).padStart(2, "0");
  const hh = String(sgt.getUTCHours()).padStart(2, "0");
  const mm = String(sgt.getUTCMinutes()).padStart(2, "0");
  const ss = String(sgt.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`;
};

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

  // Ensure default commands for everyone once
  if (!__defaultCommandsSet) {
    await safeTg(() => tgSetMyCommands(DEFAULT_COMMANDS, { type: "default" }));
    __defaultCommandsSet = true;
  }

  // Scope commands based on chat type:
  // - Private chats: use chat-level scope so commands show reliably
  // - Groups/Supergroups: use per-member scope so only approved users see extras
  const __allowed = (
    ((globalThis as any)?.process?.env?.APPROVED_USERNAMES as string) || ""
  )
    .split(",")
    .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const __uname = ((msg.from?.username || "") as string).toLowerCase();
  const isPrivate = (msg.chat?.type || "").toLowerCase() === "private";

  if (isPrivate) {
    // In 1:1 chats, set chat-level commands (the chat is the user)
    if (__uname && __allowed.includes(__uname)) {
      await safeTg(() =>
        tgSetMyCommands([...APPROVED_EXTRA_COMMANDS, ...DEFAULT_COMMANDS], {
          type: "chat",
          chat_id: chatId,
        }),
      );
    } else {
      await safeTg(() =>
        tgSetMyCommands(DEFAULT_COMMANDS, { type: "chat", chat_id: chatId }),
      );
    }
  } else if (msg.from?.id && __uname) {
    // In groups/supergroups, use chat_member scope for per-user visibility
    if (__allowed.includes(__uname)) {
      await safeTg(() =>
        tgSetMyCommands([...APPROVED_EXTRA_COMMANDS, ...DEFAULT_COMMANDS], {
          type: "chat_member",
          chat_id: chatId,
          user_id: msg.from!.id,
        }),
      );
      // Fallback: some clients ignore chat_member scoped commands. Ensure group admins see commands.
      await safeTg(() =>
        tgSetMyCommands([...APPROVED_EXTRA_COMMANDS, ...DEFAULT_COMMANDS], {
          type: "chat_administrators",
          chat_id: chatId,
        }),
      );
    } else {
      await safeTg(() =>
        tgDeleteMyCommands({
          type: "chat_member",
          chat_id: chatId,
          user_id: msg.from!.id,
        }),
      );
    }
  }

  // If a numeric keypad is active for this user, handle digit/Clear/Done
  const padKey = keyFromParts(chatId, msg.from?.id ?? 0);
  const pad = qtyPadByUser.get(padKey);
  if (pad) {
    const rawQty = (msg.text || "").trim();
    await safeTg(() => tgDeleteMessage(chatId, msg.message_id));
    const n = Number(rawQty);
    const isInt = /^[0-9]+$/.test(rawQty) && Number.isInteger(n);
    if (!isInt || n < 1 || n > 10) {
      await safeTg(() =>
        tgSendMessage(
          chatId,
          "Invalid. Please respond with a number between 1 - 10.",
        ),
      );
      return;
    }
    const qty = n;
    const drink = DRINKS[pad.idx as number];
    if (!drink) {
      qtyPadByUser.delete(padKey);
      return;
    }
    const qtyKey = keyFromParts(
      chatId,
      pad.messageId,
      pad.idx,
      pad.oat,
      pad.byoc,
    );
    pendingQtyByMessage.set(qtyKey, qty);

    const base = drink.price;
    const up = pad.oat ? OAT_UPCHARGE : 0;
    const disc = pad.byoc ? BYOC_DISCOUNT : 0;
    const unit = base + up - disc;
    const total = unit * qty;

    const confirm = buildConfirmKeyboard(pad.idx, pad.oat, pad.byoc, qty);
    const confirmText =
      pad.oat && pad.byoc
        ? `Confirm: ${drink.name} with oat milk (BYOC) — ${fmtMoney(base)} + ${fmtMoney(OAT_UPCHARGE)} − ${fmtMoney(BYOC_DISCOUNT)} = ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`
        : pad.oat && !pad.byoc
          ? `Confirm: ${drink.name} with oat milk — ${fmtMoney(base)} + ${fmtMoney(OAT_UPCHARGE)} = ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`
          : !pad.oat && pad.byoc
            ? `Confirm: ${drink.name} (BYOC) — ${fmtMoney(base)} − ${fmtMoney(BYOC_DISCOUNT)} = ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`
            : `Confirm: ${drink.name} — ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`;

    await safeTg(() => tgEditMessageText(chatId, pad.messageId, confirmText));
    await safeTg(() => tgEditReplyMarkup(chatId, pad.messageId, confirm));
    qtyPadByUser.delete(padKey);
    return;
  }

  if (text === "/start") {
    await safeTg(() =>
      tgSendMessage(chatId, "Use /menu to view our drinks menu!"),
    );
    return;
  }

  if (text === "/log") {
    const __allowed = (
      ((globalThis as any)?.process?.env?.APPROVED_USERNAMES as string) || ""
    )
      .split(",")
      .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    const __uname = ((msg.from?.username || "") as string).toLowerCase();
    if (!__uname || !__allowed.includes(__uname)) {
      await safeTg(() =>
        tgSendMessage(
          chatId,
          "Not authorized. Use /menu to view our drinks menu!",
        ),
      );
      return;
    }

    await ensureMenuLoadedOnce();
    const menu = buildMainMenu();
    await safeTg(() => tgSendMessage(chatId, "Choose a drink:", menu));
    return;
  }

  if (text === "/menu") {
    await safeTg(() => tgSendMessage(chatId, listText()));
    return;
  }

  if (text === "/pay") {
    if (!PAY_URL) {
      await safeTg(() =>
        tgSendMessage(chatId, "Payment link is not configured."),
      );
      return;
    }
    const payKb = {
      inline_keyboard: [[{ text: "Pay now", url: PAY_URL }]],
    } as any;
    await safeTg(() =>
      tgSendMessage(
        chatId,
        `Pay for your drinks using the link below:\n${PAY_URL}`,
        payKb,
      ),
    );
    return;
  }

  if (text === "/undo") {
    const __allowed = (
      ((globalThis as any)?.process?.env?.APPROVED_USERNAMES as string) || ""
    )
      .split(",")
      .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    const __uname = ((msg.from?.username || "") as string).toLowerCase();
    if (!__uname || !__allowed.includes(__uname)) {
      await safeTg(() =>
        tgSendMessage(
          chatId,
          "Not authorized. Use /menu to view our drinks menu!",
        ),
      );
      return;
    }

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
      const details = lastOrderDetailsByChat.get(key);
      lastRowByChat.delete(key);
      lastOrderDetailsByChat.delete(key);
      let undoneText: string;
      if (!details) {
        undoneText = "Undid your last order.";
      } else {
        const qtyLabel =
          details.qty && details.qty > 1 ? ` × ${details.qty}` : "";
        if (details.oatMilk && details.byoc) {
          undoneText = `Undid: ${details.drinkName} with oat milk (BYOC)${qtyLabel}.`;
        } else if (details.oatMilk) {
          undoneText = `Undid: ${details.drinkName} with oat milk${qtyLabel}.`;
        } else if (details.byoc) {
          undoneText = `Undid: ${details.drinkName} (BYOC)${qtyLabel}.`;
        } else {
          undoneText = `Undid: ${details.drinkName}${qtyLabel}.`;
        }
      }
      await safeTg(() => tgSendMessage(chatId, undoneText));
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

  // Only allow approved usernames to interact with ordering callbacks
  const __allowed = (
    ((globalThis as any)?.process?.env?.APPROVED_USERNAMES as string) || ""
  )
    .split(",")
    .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const __caller = ((cb.from?.username || "") as string).toLowerCase();
  if (!__caller || !__allowed.includes(__caller)) {
    await safeTg(() => tgAnswerCallbackQuery(cb.id, "Not authorized"));
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
      // Non-oat: show BYOC choice before confirming
      const byoc = buildByocChoice(idx, false);
      await safeTg(() =>
        tgEditMessageText(chatId, messageId, "Bring your own cup?"),
      );
      await safeTg(() => tgEditReplyMarkup(chatId, messageId, byoc));
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
    await safeTg(() => tgEditMessageText(chatId, messageId, "Milk Option:"));
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

    // After milk selection, show BYOC choice
    const byoc = buildByocChoice(idx, oatFlag);
    await safeTg(() =>
      tgEditMessageText(chatId, messageId, "Bring your own cup?"),
    );
    await safeTg(() => tgEditReplyMarkup(chatId, messageId, byoc));
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    return;
  }

  // Handle BYOC selection: B|<idx>|<oatFlag>|<byocFlag>
  if (data.startsWith("B|")) {
    const parts = data.split("|");
    const idx = Number(parts[1]);
    const oatFlag = parts[2] === "1";
    const byocFlag = parts[3] === "1";
    const drink = DRINKS[idx as number];
    if (!Number.isFinite(idx) || !drink) {
      await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
      return;
    }
    qtyPadByUser.set(keyFromParts(chatId, cb.from.id), {
      messageId,
      idx,
      oat: oatFlag,
      byoc: byocFlag,
      buffer: "",
    });
    await safeTg(() =>
      tgEditMessageText(chatId, messageId, "Enter quantity (1–10):"),
    );
    await safeTg(() =>
      tgEditReplyMarkup(chatId, messageId, { inline_keyboard: [] }),
    );
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    return;
  }
  // Quantity adjustment callbacks removed; ignore legacy Q| callbacks if any
  if (data.startsWith("Q|")) {
    await safeTg(() => tgAnswerCallbackQuery(cb.id, ""));
    return;
  }

  // Handle final confirmation: Y|<idx>|<oatFlag>|<byocFlag>|<qty>
  if (data.startsWith("Y|")) {
    const parts = data.split("|");
    const idx = Number(parts[1]);
    const oatFlag = parts[2] === "1";
    const byocFlag = parts[3] === "1";
    const qtyKey = keyFromParts(chatId, messageId, idx, oatFlag, byocFlag);
    const qtyFromMem = Math.max(
      1,
      Number(pendingQtyByMessage.get(qtyKey) || 0),
    );
    const qty = qtyFromMem || Math.max(1, Number(parts[4]) || 1);
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
      byoc: byocFlag,
      qty,
    });

    if (ok) {
      const base = drink.price;
      const up = oatFlag ? OAT_UPCHARGE : 0;
      const disc = byocFlag ? BYOC_DISCOUNT : 0;
      const unit = base + up - disc;
      const total = unit * qty;
      const savedText =
        oatFlag && byocFlag
          ? `Saved: ${drink.name} with oat milk (BYOC) — ${fmtMoney(base)} + ${fmtMoney(OAT_UPCHARGE)} − ${fmtMoney(BYOC_DISCOUNT)} = ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`
          : oatFlag && !byocFlag
            ? `Saved: ${drink.name} with oat milk — ${fmtMoney(base)} + ${fmtMoney(OAT_UPCHARGE)} = ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`
            : !oatFlag && byocFlag
              ? `Saved: ${drink.name} (BYOC) — ${fmtMoney(base)} − ${fmtMoney(BYOC_DISCOUNT)} = ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`
              : `Saved: ${drink.name} — ${fmtMoney(unit)}${qty > 1 ? ` × ${qty} = ${fmtMoney(total)}` : ""}`;
      await safeTg(() => tgEditMessageText(chatId, messageId, savedText));
      await safeTg(() =>
        tgEditReplyMarkup(chatId, messageId, { inline_keyboard: [] }),
      );
      pendingQtyByMessage.delete(qtyKey);
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
  byoc: boolean;
  qty: number;
}): Promise<boolean> {
  try {
    const drink = DRINKS[params.drinkIdx];
    if (!drink) throw new Error("Invalid drink index");

    const username = params.user.username ? `@${params.user.username}` : "";
    const fullName = [params.user.first_name, params.user.last_name]
      .filter(Boolean)
      .join(" ");

    const priceFinal = Number(
      (
        drink.price +
        (params.oat ? OAT_UPCHARGE : 0) -
        (params.byoc ? BYOC_DISCOUNT : 0)
      ).toFixed(2),
    );

    let drinkLabel = params.oat ? `${drink.name} (oat)` : drink.name;
    if (params.byoc) drinkLabel += " (byoc)";

    const row: OrderRow = {
      timestamp: nowIso(),
      chatId: params.chatId,
      userId: params.user.id,
      username,
      fullName,
      drink: drinkLabel,
      price: priceFinal,
      qty: params.qty,
      total: Number((priceFinal * params.qty).toFixed(2)),
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
      lastOrderDetailsByChat.set(key, {
        drinkName: drink.name,
        oatMilk: params.oat,
        byoc: params.byoc,
        qty: params.qty,
      });
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
