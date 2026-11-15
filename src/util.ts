// Shared helpers for the v02 forge: hashing, base64, ids, deterministic clocks.
// Everything here is stdlib-only and has no I/O, so any module may import it.

import { createHash } from 'node:crypto';

/** SHA-1 hex of `data`. */
export function sha1(data: Uint8Array | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of bytes. */
export function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Bytes from standard base64 (whitespace-tolerant). */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** UTF-8 bytes of a string. */
export function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

/** Whether `value` is a lowercase 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/**
 * A deterministic clock: a base epoch plus a counter that advances on every tick, so two runs
 * on the same data produce the same timestamps and the same commit ids. Never the wall clock.
 */
export class TickClock {
  private next: number;
  constructor(baseEpochSec: number) {
    this.next = baseEpochSec;
  }
  /** The next second, strictly increasing. */
  tick(): number {
    const value = this.next;
    this.next += 1;
    return value;
  }
  /** The current second without advancing. */
  peek(): number {
    return this.next;
  }
  /** An ISO-8601 string for `epochSec` (or the current tick, without advancing). */
  iso(epochSec?: number): string {
    return new Date((epochSec ?? this.next) * 1000).toISOString();
  }
}

/** A per-process request counter for the X-GitHub-Request-Id header. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Escape a string for safe inclusion in a JSON error message (no control characters). */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
