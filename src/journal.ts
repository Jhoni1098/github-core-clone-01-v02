// The storage engine: a single append-only journal file.
//
// Every durable change is one record: a 4-byte big-endian length, a 1-byte type tag, and a JSON
// payload (binary object bytes are base64 inside the payload). Records are appended in one
// writeSync per mutation, so a crash can only lose or tear the final record. On boot the journal
// is scanned front to back and the in-memory index is rebuilt; a torn trailing record is ignored.
//
// When the journal grows past the compaction threshold it is rewritten from the current state
// (a fresh journal holding exactly the live records). Compaction happens at boot and after large
// writes, never in the middle of a trial's hot path.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** The record kinds the journal carries. */
export const RECORD_TYPES = {
  repo: 0x01,
  object: 0x02,
  ref: 0x03,
  issue: 0x04,
  pull: 0x05,
  comment: 0x06,
  label: 0x07,
  meta: 0x08,
  deleteRepo: 0x09,
} as const;

export type RecordType = (typeof RECORD_TYPES)[keyof typeof RECORD_TYPES];

/** A decoded journal record: its type tag and its JSON payload. */
export interface JournalRecord {
  readonly type: RecordType;
  readonly payload: Record<string, unknown>;
}

const COMPACT_THRESHOLD_BYTES = 64 * 1024 * 1024;

export class Journal {
  readonly #path: string;
  #sizeBytes = 0;

  constructor(directory: string, filename = 'journal.log') {
    mkdirSync(directory, { recursive: true });
    this.#path = join(directory, filename);
    if (existsSync(this.#path)) {
      this.#sizeBytes = readFileSync(this.#path).length;
    } else {
      writeFileSync(this.#path, Buffer.alloc(0));
      this.#sizeBytes = 0;
    }
  }

  get path(): string {
    return this.#path;
  }

  get sizeBytes(): number {
    return this.#sizeBytes;
  }

  /** Append one record atomically (a single writeSync) and return its byte length. */
  append(type: RecordType, payload: Record<string, unknown>): number {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(5);
    header.writeUInt32BE(body.length, 0);
    header.writeUInt8(type, 4);
    const record = Buffer.concat([header, body]);
    appendFileSync(this.#path, record);
    this.#sizeBytes += record.length;
    return record.length;
  }

  /** Append several records in one writeSync (one mutation = one flush). */
  appendMany(records: readonly { type: RecordType; payload: Record<string, unknown> }[]): number {
    if (records.length === 0) return 0;
    const chunks: Buffer[] = [];
    let total = 0;
    for (const record of records) {
      const body = Buffer.from(JSON.stringify(record.payload), 'utf8');
      const header = Buffer.alloc(5);
      header.writeUInt32BE(body.length, 0);
      header.writeUInt8(record.type, 4);
      chunks.push(header, body);
      total += 5 + body.length;
    }
    appendFileSync(this.#path, Buffer.concat(chunks));
    this.#sizeBytes += total;
    return total;
  }

  /** Scan the journal front to back, decoding every complete record. A torn tail is ignored. */
  scan(): JournalRecord[] {
    if (!existsSync(this.#path)) return [];
    const data = readFileSync(this.#path);
    const records: JournalRecord[] = [];
    let offset = 0;
    while (offset + 5 <= data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.readUInt8(offset + 4) as RecordType;
      if (offset + 5 + length > data.length) break; // torn trailing record: ignore it.
      const payload = JSON.parse(data.subarray(offset + 5, offset + 5 + length).toString('utf8')) as Record<string, unknown>;
      records.push({ type, payload });
      offset += 5 + length;
    }
    return records;
  }

  /** Rewrite the journal from a snapshot of live records (compaction). */
  compact(records: readonly JournalRecord[]): void {
    const chunks: Buffer[] = [];
    for (const record of records) {
      const body = Buffer.from(JSON.stringify(record.payload), 'utf8');
      const header = Buffer.alloc(5);
      header.writeUInt32BE(body.length, 0);
      header.writeUInt8(record.type, 4);
      chunks.push(header, body);
    }
    const tmpPath = `${this.#path}.tmp`;
    writeFileSync(tmpPath, Buffer.concat(chunks));
    renameSync(tmpPath, this.#path);
    this.#sizeBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  needsCompaction(): boolean {
    return this.#sizeBytes > COMPACT_THRESHOLD_BYTES;
  }
}
