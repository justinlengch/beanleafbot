/**
 * Minimal Node/global shims for serverless TypeScript builds without @types/node.
 * These declarations satisfy the few Node globals and modules we use.
 *
 * Scope:
 * - Globals: process, console, Buffer
 * - Module: "http" (IncomingMessage, ServerResponse) — minimal members we rely on
 * - Modules: "googleapis", "google-auth-library" — very light type stubs
 *
 * Note:
 * - Fetch, AbortController, setTimeout are provided by lib DOM (see tsconfig "lib": ["DOM"])
 */

declare global {
  // Minimal env access used throughout the project
  // e.g., process.env.BOT_TOKEN
  var process: {
    env: Record<string, string | undefined>;
  };

  // Basic console surface to keep TS happy in non-DOM contexts
  var console: {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    info: (...args: any[]) => void;
  };

  // Very small Buffer surface for request body handling
  // We only call Buffer.from, Buffer.concat, and Buffer.isBuffer
  var Buffer: {
    from(input: any, encoding?: string): any;
    concat(list: any[]): any;
    isBuffer(obj: any): boolean;
  };

  // CommonJS require shim for TypeScript without @types/node
  var require: (name: string) => any;
}

// Minimal subset of Node's "http" module types we actually use.
declare module "http" {
  export interface IncomingMessage {
    headers?: any;
    method?: string;
    on(event: "data", listener: (chunk: any) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: any) => void): this;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: any): void;
  }
}

// Lightweight stubs for google APIs to avoid requiring @types during build.
// The runtime packages provide the implementations.
declare module "googleapis" {
  export const google: any;
  export namespace sheets_v4 {
    export type Sheets = any;
  }
}

declare module "google-auth-library" {
  export class JWT {
    constructor(options: any);
  }
}

export {};
