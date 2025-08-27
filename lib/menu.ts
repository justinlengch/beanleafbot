/**
 * Static menu definition and helpers for building Telegram inline keyboards.
 *
 * Exports:
 * - DRINKS: readonly menu items
 * - OAT_UPCHARGE: number
 * - fmtMoney(n): string
 * - buildMainMenu(): InlineKeyboardMarkup (2 columns, D|<idx> callback)
 * - buildOatChoice(idx): InlineKeyboardMarkup (Regular / With Oat, C|<idx>|<0|1>)
 * - listText(): string (bullet list with prices; marks oat-eligible)
 * - drinkByIndex(idx): Drink | undefined
 * - totalWithOat(base, oat): number
 */

import { getSheetsAuth, SHEETS_TIMEOUT_MS } from "./sheets";

export type Drink = {
  name: string;
  price: number;
  oat: boolean;
};

export const OAT_UPCHARGE = 0.5;
export const BYOC_DISCOUNT = 0.5;

export let DRINKS: Drink[] = [
  { name: "Americano", price: 3.0, oat: false },
  { name: "Honey Americano", price: 3.5, oat: false },
  { name: "Latte", price: 3.0, oat: true },
  { name: "Biscoff Latte", price: 3.5, oat: true },
  { name: "Peanut Butter Latte", price: 3.5, oat: true },
  { name: "Cappuccino", price: 3.8, oat: true },
  { name: "Mocha", price: 4.5, oat: true },
  { name: "Chocolate", price: 3.0, oat: true },
  { name: "Matcha Latte", price: 3.5, oat: true },
  { name: "Salted Honey Matcha", price: 4.0, oat: true },
  { name: "Strawberry Matcha", price: 4.0, oat: true },
  { name: "Hibiscus Strawberry Tea", price: 2.5, oat: false },
  { name: "Hibiscus Lemonade", price: 3.0, oat: false },
];

const SHEET_ID = (globalThis as any)?.process?.env?.SHEET_ID || "";

let __menuLoadOnce: Promise<void> | null = null;

function coerceBool(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "y" || s === "1";
  }
  return false;
}

async function loadMenuFromSheet(): Promise<void> {
  if (!SHEET_ID) return;
  try {
    const auth = await getSheetsAuth();
    const resp = await auth.sheets.spreadsheets.values.get(
      {
        spreadsheetId: SHEET_ID,
        range: "Menu!A:C",
        valueRenderOption: "UNFORMATTED_VALUE",
      },
      { timeout: SHEETS_TIMEOUT_MS },
    );
    const values: any[][] = (resp && resp.data && resp.data.values) || [];
    if (!values.length) return;

    let start = 0;
    const header = values[0].map((x: any) =>
      String(x ?? "")
        .trim()
        .toLowerCase(),
    );
    if (header.includes("name") && header.includes("price")) {
      start = 1;
    }

    const newMenu: Drink[] = [];
    for (let i = start; i < values.length; i++) {
      const row = values[i];
      if (!row || row.length === 0) continue;
      const name = row[0];
      const price = row[1];
      const oat = row[2];
      if (!name) continue;
      const p = Number(price);
      if (!Number.isFinite(p)) continue;
      newMenu.push({
        name: String(name),
        price: Number(p),
        oat: coerceBool(oat),
      });
    }

    if (newMenu.length) {
      // Update exported DRINKS in place to preserve import binding
      (DRINKS as Drink[]).length = 0;
      (DRINKS as Drink[]).push(...newMenu);
    }
  } catch (e: any) {
    console.error(`menu load error: ${e?.message || String(e)}`);
  }
}

export function ensureMenuLoadedOnce(): Promise<void> {
  if (!__menuLoadOnce) {
    __menuLoadOnce = loadMenuFromSheet();
  }
  return __menuLoadOnce;
}

// Trigger load once per instance, but don't block callers
void ensureMenuLoadedOnce();

/**
 * Minimal Telegram inline keyboard types to avoid cross-deps.
 */
export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

/**
 * Format as $X.XX
 */
export function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Compute total with optional oat upcharge.
 */
export function totalWithOat(base: number, oat: boolean): number {
  return Number((base + (oat ? OAT_UPCHARGE : 0)).toFixed(2));
}

/**
 * Safe index lookup.
 */
export function drinkByIndex(idx: number): Drink | undefined {
  if (!Number.isFinite(idx)) return undefined;
  return DRINKS[idx as number];
}

/**
 * Build the main 2-column inline keyboard with drink choices.
 * Label: "Drink Name"
 * callback_data: D|<idx>
 */
export function buildMainMenu(): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[] = DRINKS.map((d, idx) => {
    const label = d.name;
    return { text: label, callback_data: `D|${idx}` };
  });
  return { inline_keyboard: chunk(buttons, 2) };
}

/**
 * Build the two-button oat choice keyboard for a given drink index.
 * Buttons:
 * - Dairy Milk => C|idx|0
 * - Oat Milk   => C|idx|1
 */
export function buildOatChoice(idx: number): InlineKeyboardMarkup {
  const drink = drinkByIndex(idx);
  if (!drink) return { inline_keyboard: [] };
  const regular: InlineKeyboardButton = {
    text: `Dairy Milk`,
    callback_data: `C|${idx}|0`,
  };
  const withOat: InlineKeyboardButton = {
    text: `Oat Milk`,
    callback_data: `C|${idx}|1`,
  };
  return { inline_keyboard: [[regular, withOat]] };
}

/**
 * Build a two-button BYOC choice keyboard for a given drink index and oat flag.
 * Buttons:
 * - Use shop cup     => B|idx|oat|0
 * - Bring your own   => B|idx|oat|1
 */
export function buildByocChoice(
  idx: number,
  oat: boolean,
): InlineKeyboardMarkup {
  const drink = drinkByIndex(idx);
  if (!drink) return { inline_keyboard: [] };
  const noByoc: InlineKeyboardButton = {
    text: `No`,
    callback_data: `B|${idx}|${oat ? 1 : 0}|0`,
  };
  const withByoc: InlineKeyboardButton = {
    text: `Yes`,
    callback_data: `B|${idx}|${oat ? 1 : 0}|1`,
  };
  return { inline_keyboard: [[withByoc, noByoc]] };
}

/**
 * Bullet list text of all drinks with prices.
 * Shows price adjustments note at the top.
 */
export function listText(): string {
  const up = OAT_UPCHARGE.toFixed(2);
  const disc = BYOC_DISCOUNT.toFixed(2);
  const header = `(oat milk +${up}, BYOC -${disc})`;
  const lines = DRINKS.map((d) => `• ${d.name} — ${fmtMoney(d.price)}`);
  return [header, ...lines].join("\n");
}

/**
 * Utility: split array into fixed-size chunks.
 */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
}

/**
 * Build a simple confirmation keyboard without quantity controls.
 *
 * Buttons:
 * - Confirm: "Y|<idx>|<oatFlag 0|1>|<byocFlag 0|1>"
 * - Cancel:  "N|<idx>"
 *
 * Note: Quantity should be entered by the user via text (limit externally).
 */
export function buildConfirmKeyboard(
  idx: number,
  oat: boolean,
  byoc: boolean = false,
  qty: number = 1,
): InlineKeyboardMarkup {
  const confirm: InlineKeyboardButton = {
    text: "✅ Confirm",
    callback_data: `Y|${idx}|${oat ? 1 : 0}|${byoc ? 1 : 0}`,
  };
  const cancel: InlineKeyboardButton = {
    text: "↩ Cancel",
    callback_data: `N|${idx}`,
  };
  return { inline_keyboard: [[confirm, cancel]] };
}
