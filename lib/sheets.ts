/**
 * Google Sheets helpers (JWT auth) for append-only order logging.
 *
 * Exports:
 * - getSheetsAuth(): Promise<SheetsAuth>
 * - ensureSheet(auth, spreadsheetId, title?): Promise<void>
 * - appendOrder(auth, spreadsheetId, row, title?) OR appendOrder(auth, spreadsheetId, title, row): Promise<void>
 *
 * Env required:
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL
 * - GOOGLE_PRIVATE_KEY (handle \n correctly)
 *
 * Notes:
 * - Uses googleapis + google-auth-library via JWT service account.
 * - Ensure the target spreadsheet is shared with the service account email.
 * - Append is performed with valueInputOption: RAW.
 */

// Using require() to avoid TS type resolution on googleapis in serverless builds
const google: any = require("googleapis").google;
// Minimal namespace stub to satisfy types without full @types
declare namespace sheets_v4 {
  type Sheets = any;
}
// Runtime uses google.auth.JWT; provide a lightweight type alias for TS
type JWT = any;

export const SHEETS_TIMEOUT_MS = 8000;

const SVC_EMAIL =
  (globalThis as any)?.process?.env?.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const RAW_PRIVATE_KEY =
  (globalThis as any)?.process?.env?.GOOGLE_PRIVATE_KEY || "";

/**
 * Row schema for the Orders sheet.
 * Columns (A-L):
 * Timestamp | ChatId | UserId | Username | FullName | Drink | Price | Qty | Total | OatMilk | MessageId | CallbackId
 */
export type OrderRow = {
  timestamp: string; // ISO string
  chatId: number;
  userId: number;
  username: string;
  fullName: string;
  drink: string;
  price: number;
  qty: number; // always 1
  total: number; // price * qty
  oatMilk: boolean;
  messageId: number;
  callbackId: string;
};

export type SheetsAuth = {
  jwt: JWT;
  sheets: sheets_v4.Sheets;
};

function normalizePrivateKey(key: string): string {
  // Vercel and many envs store newlines escaped
  return key.replace(/\\n/g, "\n");
}

/**
 * Creates an authenticated Sheets client using a service account (JWT).
 */
export async function getSheetsAuth(): Promise<SheetsAuth> {
  if (!SVC_EMAIL) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
  if (!RAW_PRIVATE_KEY) throw new Error("GOOGLE_PRIVATE_KEY is not set");

  const jwt = new google.auth.JWT({
    email: SVC_EMAIL,
    key: normalizePrivateKey(RAW_PRIVATE_KEY),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth: jwt });
  return { jwt, sheets };
}

/**
 * Ensures a sheet with the given title exists, and writes the header row if newly created.
 */
export async function ensureSheet(
  auth: SheetsAuth,
  spreadsheetId: string,
  title = "Orders",
): Promise<void> {
  // Check if sheet exists
  const meta = await auth.sheets.spreadsheets.get(
    { spreadsheetId, includeGridData: false },
    { timeout: SHEETS_TIMEOUT_MS },
  );

  const sheets = meta.data.sheets || [];
  const exists = sheets.some((s: any) => s.properties?.title === title);
  if (exists) return;

  // Create sheet
  await auth.sheets.spreadsheets.batchUpdate(
    {
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    },
    { timeout: SHEETS_TIMEOUT_MS },
  );

  // Write header row
  await auth.sheets.spreadsheets.values.update(
    {
      spreadsheetId,
      range: `${title}!A1:L1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          [
            "Timestamp",
            "ChatId",
            "UserId",
            "Username",
            "FullName",
            "Drink",
            "Price",
            "Qty",
            "Total",
            "OatMilk",
            "MessageId",
            "CallbackId",
          ],
        ],
      },
    },
    { timeout: SHEETS_TIMEOUT_MS },
  );
}

/**
 * Appends a single order row.
 *
 * Supports two calling styles for convenience:
 * - appendOrder(auth, spreadsheetId, row, title?)
 * - appendOrder(auth, spreadsheetId, title, row)
 */
export async function appendOrder(
  auth: SheetsAuth,
  spreadsheetId: string,
  arg3: OrderRow | string,
  arg4?: OrderRow,
): Promise<void> {
  let title = "Orders";
  let row: OrderRow;

  if (typeof arg3 === "string") {
    // Signature: (auth, spreadsheetId, title, row)
    title = arg3;
    if (!arg4) throw new Error("appendOrder: row is required");
    row = arg4;
  } else {
    // Signature: (auth, spreadsheetId, row)
    row = arg3;
  }

  await auth.sheets.spreadsheets.values.append(
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
    { timeout: SHEETS_TIMEOUT_MS },
  );
}
