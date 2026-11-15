// Git plumbing, built from the kit's git-client contract: the object model, the pack codec,
// and the pkt-line / sideband framing the smart HTTP surfaces speak.
//
// Supported object kinds: commit, tree, blob, tag. Packs: v2 and v3, with OFS_DELTA and
// REF_DELTA resolution; writes emit whole objects only (no deltas), which the contract allows.
// Pack trailers are verified on read.

import { createInflate, inflateSync, deflateSync } from 'node:zlib';
import { b64decode, b64encode, isOid, sha1, ZERO_OID } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

export function makeObject(type: GitObjectType, data: Buffer): GitObject {
  return { type, data, oid: hashObject(type, data) };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: missing mode separator');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1) throw new Error('malformed tree: missing name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize a tree, in git's sort order (directories sort as if their name ended with '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse commit headers into a Map (later duplicate keys are dropped). */
export function parseCommit(data: Buffer): Map<string, string> {
  const headerEnd = data.indexOf('\n\n');
  const header = headerEnd === -1 ? data : data.subarray(0, headerEnd);
  const fields = new Map<string, string>();
  for (const line of header.toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    if (!fields.has(key)) fields.set(key, line.slice(space + 1));
  }
  return fields;
}

export interface CommitSpec {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/** Serialize a commit with the fixed forge identity and no extra trailing newline. */
export function buildCommit(spec: CommitSpec, author: string): Buffer {
  const lines: string[] = [`tree ${spec.tree}`];
  for (const parent of spec.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${author}`);
  return Buffer.from(`${lines.join('\n')}\n\n${spec.message}`, 'utf8');
}

/** The canonical zeroed object id. */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

export function emptyTree(): GitObject {
  return { type: 'tree', data: Buffer.alloc(0), oid: EMPTY_TREE_OID };
}

/* ------------------------------------------------------------------ */
/* Pack reading                                                        */
/* ------------------------------------------------------------------ */

/** A pack entry after delta resolution, before it is stored. */
export interface PackObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

const PACK_TYPES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaInt = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] ?? 0;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readDeltaInt();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaInt();
  const chunks: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos] as number, pos += 1;
      if (op & 0x02) offset |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x04) offset |= (delta[pos] as number) << 16, pos += 1;
      if (op & 0x08) offset |= (delta[pos] as number) << 24, pos += 1;
      if (op & 0x10) size = delta[pos] as number, pos += 1;
      if (op & 0x20) size |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x40) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (written !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

export async function parsePack(pack: Buffer): Promise<PackObject[]> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, PackObject>();
  const objects: PackObject[] = [];
  const unresolved = new Map<number, { baseOid: string; delta: Buffer }>();

  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    const first = pack[offset] as number;
    const typeId = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeId === 6) {
      // OFS_DELTA: base offset encoded as a negative offset varint.
      let byte = pack[offset] as number;
      let base = byte & 0x7f;
      offset += 1;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        base = ((base + 1) << 7) | (byte & 0x7f);
        offset += 1;
      }
      baseOffset = entryStart - base;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    let data: Buffer;
    try {
      data = inflateSync(pack.subarray(offset));
    } catch {
      throw new Error('pack entry inflation failed');
    }
    // Find where this entry's deflate stream ends: a streaming inflate stops exactly at the
    // stream boundary, and bytesWritten is the compressed length consumed.
    offset += await inflateLength(pack.subarray(offset));
    if (typeId === 6 || typeId === 7) {
      const base = baseOid ?? (baseOffset !== null ? byOffset.get(baseOffset)?.oid : undefined);
      if (base === undefined) {
        // Base not seen yet (out-of-order pack): keep the delta and resolve after the loop.
        unresolved.set(entryStart, { baseOid: baseOid ?? '', delta: data });
        continue;
      }
      const baseObject = byOffset.get(baseOffset ?? -1) ?? objects.find((o) => o.oid === base);
      if (!baseObject) throw new Error('delta base not found');
      const resolved = applyDelta(baseObject.data, data);
      const obj: PackObject = { type: baseObject.type, data: resolved, oid: hashObject(baseObject.type, resolved) };
      objects.push(obj);
      byOffset.set(entryStart, obj);
      continue;
    }
    const type = PACK_TYPES[typeId];
    if (!type) throw new Error(`unknown pack object type ${typeId}`);
    if (data.length !== size) throw new Error('pack object size mismatch');
    const obj: PackObject = { type, data, oid: hashObject(type, data) };
    objects.push(obj);
    byOffset.set(entryStart, obj);
  }

  // Resolve any out-of-order deltas now that all bases are known.
  for (const [entryStart, pending] of unresolved) {
    const baseObject = pending.baseOid
      ? objects.find((o) => o.oid === pending.baseOid)
      : byOffset.get(entryStart);
    if (!baseObject) throw new Error('delta base not found after full scan');
    const resolved = applyDelta(baseObject.data, pending.delta);
    const obj: PackObject = { type: baseObject.type, data: resolved, oid: hashObject(baseObject.type, resolved) };
    objects.push(obj);
    byOffset.set(entryStart, obj);
  }

  // Verify the trailer (SHA-1 of the whole pack body) when present.
  if (pack.length >= offset + 20) {
    const expected = pack.subarray(offset, offset + 20).toString('hex');
    const actual = sha1(pack.subarray(0, offset));
    if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  }
  return objects;
}

/** The compressed length of the deflate stream at the start of `data`: a streaming inflate stops
 * exactly at the stream boundary, and `bytesWritten` is what it consumed. */
function inflateLength(data: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    let settled = false;
    inflater.on('data', () => {
      // Drain the output; the length is what matters here.
    });
    inflater.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    inflater.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(inflater.bytesWritten);
      }
    });
    inflater.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Pack writing (whole objects only — no deltas, which the contract allows) */
/* ------------------------------------------------------------------ */

export function buildPack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    const typeId = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/* ------------------------------------------------------------------ */
/* pkt-line                                                            */
/* ------------------------------------------------------------------ */

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');

/** One decoded packet: a data payload, a flush (0000) or a delimiter (0001). */
export type PktLine =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Decode a pkt-line stream. Stops at the end of the buffer; callers that expect raw bytes after a
 * flush (receive-pack) should use findFlushOffset instead of feeding the whole body here. */
export function parsePktLines(data: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const length = parseInt(data.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('malformed pkt-line length');
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > data.length) throw new Error('malformed pkt-line');
    out.push({ kind: 'data', payload: data.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** The byte offset just after the first flush packet, or -1 when the body has no flush. */
export function findFlushOffset(data: Buffer): number {
  let offset = 0;
  while (offset + 4 <= data.length) {
    const length = parseInt(data.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length === 1) return -1;
    if (length === 0) return offset + 4;
    if (length < 4 || offset + length > data.length) return -1;
    offset += length;
  }
  return -1;
}

/** Encode a packfile in a sideband-64k channel (band 1 = data). */
export function sidebandEncode(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = 65520 - 5; // 4-byte length + 1-byte band, leaving the length itself.
  for (let offset = 0; offset < pack.length; offset += maxPayload) {
    const chunk = pack.subarray(offset, Math.min(offset + maxPayload, pack.length));
    const length = chunk.length + 5;
    const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
    parts.push(Buffer.concat([header, Buffer.from([1]), chunk]));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** Demultiplex a sideband stream, returning band 1 (pack) and band 2 (progress) bytes. */
export function sidebandDecode(data: Buffer): { pack: Buffer; progress: Buffer } {
  const packChunks: Buffer[] = [];
  const progressChunks: Buffer[] = [];
  for (const packet of parsePktLines(data)) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload;
    if (line.length === 0) continue;
    const band = line[0] as number;
    if (band === 1) packChunks.push(line.subarray(1));
    else if (band === 2) progressChunks.push(line.subarray(1));
  }
  return { pack: Buffer.concat(packChunks), progress: Buffer.concat(progressChunks) };
}

/** Parse a v2 request body into its named sections: `command`, `want`, `have`, `deepen`, ... */
export function parseFetchRequest(body: Buffer): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  const add = (key: string, value: string): void => {
    const list = sections.get(key) ?? [];
    list.push(value);
    sections.set(key, list);
  };
  for (const packet of parsePktLines(body)) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('command=')) {
      add('command', text.slice('command='.length));
      continue;
    }
    if (text.startsWith('object-format=')) {
      add('object-format', text.slice('object-format='.length));
      continue;
    }
    const space = text.indexOf(' ');
    if (space === -1) add(text, '');
    else add(text.slice(0, space), text.slice(space + 1));
  }
  return sections;
}

/** Re-export shared helpers the HTTP layer needs. */
export { b64decode, b64encode, isOid, sha1, ZERO_OID };
