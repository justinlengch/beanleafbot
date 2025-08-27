/**
 * Telegram helper library with time-bounded calls.
 *
 * - Uses raw HTTPS via global fetch (Node 18+ / Vercel).
 * - Exposes small helpers used by the webhook handler.
 * - No dependencies.
 *
 * Env:
 * - BOT_TOKEN (required)
 * - ADMIN_CHAT_ID (optional)
 */

const BOT_TOKEN = (globalThis as any)?.process?.env?.BOT_TOKEN || "";
const ADMIN_CHAT_ID = (globalThis as any)?.process?.env?.ADMIN_CHAT_ID || "";

/**
 * Default timeout for Telegram API calls (in ms).
 * Can be overridden per-call.
 */
export const TELEGRAM_TIMEOUT_MS = 6500;

const TELEGRAM_BASE = () => {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not set");
  }
  return `https://api.telegram.org/bot${BOT_TOKEN}`;
};

export type TgInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TgInlineKeyboardMarkup = {
  inline_keyboard: TgInlineKeyboardButton[][];
};

export type TgKeyboardButton = {
  text: string;
  request_contact?: boolean;
  request_location?: boolean;
};

export type TgReplyKeyboardMarkup = {
  keyboard: TgKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  selective?: boolean;
};

export type TgReplyKeyboardRemove = {
  remove_keyboard: true;
  selective?: boolean;
};

export type TgReplyMarkup =
  | TgInlineKeyboardMarkup
  | TgReplyKeyboardMarkup
  | TgReplyKeyboardRemove;

type TgApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: unknown;
};

async function callTelegram<T = any>(
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number = TELEGRAM_TIMEOUT_MS,
): Promise<T> {
  const url = `${TELEGRAM_BASE()}/${method}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data: TgApiEnvelope<T> | undefined;
    try {
      data = (await res.json()) as TgApiEnvelope<T>;
    } catch {
      // If Telegram returns a non-JSON reply (rare), surface an error
      throw new Error(
        `Telegram ${method} failed: non-JSON response (${res.status} ${res.statusText})`,
      );
    }

    if (!res.ok || !data.ok) {
      const desc = data?.description ? ` - ${data.description}` : "";
      throw new Error(
        `Telegram ${method} failed: ${res.status} ${res.statusText}${desc}`,
      );
    }

    return data.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a message to a chat.
 */
export function tgSendMessage(
  chat_id: number,
  text: string,
  reply_markup?: TgReplyMarkup,
  options?: {
    disable_notification?: boolean;
    timeoutMs?: number;
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
    input_field_placeholder?: string;
  },
) {
  return callTelegram(
    "sendMessage",
    {
      chat_id,
      text,
      parse_mode: options?.parse_mode ?? "HTML",
      reply_markup,
      disable_notification: options?.disable_notification ?? true,
      input_field_placeholder: options?.input_field_placeholder,
    },
    options?.timeoutMs,
  );
}

/**
 * Edit the text of an existing message (in the same chat).
 */
export function tgEditMessageText(
  chat_id: number,
  message_id: number,
  text: string,
  options?: {
    timeoutMs?: number;
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  },
) {
  return callTelegram(
    "editMessageText",
    {
      chat_id,
      message_id,
      text,
      parse_mode: options?.parse_mode ?? "HTML",
    },
    options?.timeoutMs,
  );
}

/**
 * Edit the inline keyboard (reply markup) of an existing message.
 * Pass an empty keyboard to remove buttons.
 */
export function tgEditReplyMarkup(
  chat_id: number,
  message_id: number,
  reply_markup?: TgInlineKeyboardMarkup,
  options?: { timeoutMs?: number },
) {
  return callTelegram(
    "editMessageReplyMarkup",
    {
      chat_id,
      message_id,
      reply_markup,
    },
    options?.timeoutMs,
  );
}

/**
 * Delete a message.
 */
export function tgDeleteMessage(
  chat_id: number,
  message_id: number,
  options?: { timeoutMs?: number },
) {
  return callTelegram(
    "deleteMessage",
    {
      chat_id,
      message_id,
    },
    options?.timeoutMs,
  );
}

/**
 * Answer a callback query. Use empty text to silently acknowledge.
 */
export function tgAnswerCallbackQuery(
  callback_query_id: string,
  text?: string,
  options?: { show_alert?: boolean; cache_time?: number; timeoutMs?: number },
) {
  return callTelegram(
    "answerCallbackQuery",
    {
      callback_query_id,
      text,
      show_alert: options?.show_alert ?? false,
      cache_time: options?.cache_time ?? 0,
    },
    options?.timeoutMs,
  );
}

/**
 * Optional helper to notify an admin chat about errors or events.
 * No-ops if ADMIN_CHAT_ID is not set.
 */
export async function tgNotifyAdmin(
  text: string,
  options?: { timeoutMs?: number },
) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await tgSendMessage(Number(ADMIN_CHAT_ID), text, undefined, {
      timeoutMs: options?.timeoutMs,
    });
  } catch {
    // Swallow errors to avoid cascading failures.
  }
}

export type TgBotCommand = {
  command: string;
  description: string;
};

export type TgBotCommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "all_group_chats" }
  | { type: "all_chat_administrators" }
  | { type: "chat"; chat_id: number | string }
  | { type: "chat_administrators"; chat_id: number | string }
  | { type: "chat_member"; chat_id: number | string; user_id: number };

/**
 * Set the list of bot commands. Optionally scope to a chat, user, or language.
 * See: https://core.telegram.org/bots/api#setmycommands
 */
export function tgSetMyCommands(
  commands: TgBotCommand[],
  scope?: TgBotCommandScope,
  language_code?: string,
  options?: { timeoutMs?: number },
) {
  return callTelegram(
    "setMyCommands",
    {
      commands,
      scope,
      language_code,
    },
    options?.timeoutMs,
  );
}

/**
 * Delete the list of bot commands for the given scope/language.
 * See: https://core.telegram.org/bots/api#deletemycommands
 */
export function tgDeleteMyCommands(
  scope?: TgBotCommandScope,
  language_code?: string,
  options?: { timeoutMs?: number },
) {
  return callTelegram(
    "deleteMyCommands",
    {
      scope,
      language_code,
    },
    options?.timeoutMs,
  );
}
