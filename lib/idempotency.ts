/**
 * Idempotency helpers: a tiny in-memory LRU set and a once-guard.
 *
 * Designed for serverless runtimes: instances are ephemeral and per-pod.
 * This is acceptable for Telegram webhook idempotency and UI "once" guards.
 *
 * Usage examples:
 * - Update id dedupe:
 *     const seenUpdates = new LRUSet<number>(1000);
 *     if (seenUpdates.has(update.update_id)) return; // duplicate
 *     seenUpdates.add(update.update_id);
 *
 * - One-time UI action (e.g., show oat choice only once per message):
 *     const milkOnce = new OnceGuard<string>(1000);
 *     const key = keyFromParts(chatId, messageId, idx);
 *     if (milkOnce.once(key)) {
 *       // first time -> show buttons
 *     } else {
 *       // already shown, ignore
 *     }
 */

/**
 * A minimal LRU Set implementation using Map to preserve insertion order.
 * - add() refreshes recency if key already exists
 * - when size exceeds capacity, evicts the oldest key
 */
export class LRUSet<T> {
  private max: number;
  private map: Map<T, true>;

  constructor(max = 1000) {
    if (max <= 0 || !Number.isFinite(max)) {
      throw new Error("LRUSet: max must be a positive finite number");
    }
    this.max = max;
    this.map = new Map();
  }

  has(key: T): boolean {
    return this.map.has(key);
  }

  add(key: T): void {
    if (this.map.has(key)) {
      // Refresh recency by re-inserting
      this.map.delete(key);
    }
    this.map.set(key, true);
    if (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value as T | undefined;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }

  delete(key: T): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * A convenience wrapper around LRUSet that provides a "once" pattern.
 * - once(key): returns true the first time (and remembers), false thereafter.
 * - mark(key): mark as seen
 * - has(key): check if seen
 */
export class OnceGuard<K = string> {
  private seen: LRUSet<K>;

  constructor(max = 1000) {
    this.seen = new LRUSet<K>(max);
  }

  /**
   * Returns true if it's the first time the key is seen, marking it as seen.
   * Returns false if the key has already been seen.
   */
  once(key: K): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  has(key: K): boolean {
    return this.seen.has(key);
  }

  mark(key: K): void {
    this.seen.add(key);
  }

  delete(key: K): boolean {
    return this.seen.delete(key);
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Utility to build stable string keys from heterogenous parts.
 * - Filters out null/undefined parts
 * - Joins remaining parts with ':'
 */
export function keyFromParts(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .filter((p): p is string | number | boolean => p !== null && p !== undefined)
    .map((p) => (typeof p === "boolean" ? (p ? "1" : "0") : String(p)))
    .join(":");
}
