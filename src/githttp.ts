// Git smart HTTP: the two services the suite speaks.
//
//   GET  /:owner/:repo/info/refs?service=git-upload-pack   → v2 capability advertisement
//   GET  /:owner/:repo/info/refs?service=git-receive-pack  → v0 ref advertisement
//   POST /:owner/:repo/git-upload-pack                      → ls-refs / fetch (protocol v2)
//   POST /:owner/:repo/git-receive-pack                     → push (protocol v0, report-status)
//
// The advertisement shapes, the section framing, the sideband packfile and the push report all
// follow the kit's git-client contract exactly: v2 fetch sections are delimited with 0001 packets,
// the packfile section is sideband-framed (band 1 = pack, band 2 = progress), and the push report
// is pkt-framed inside sideband band 1 when the client asked for side-band-64k.

import { buildPack, findFlushOffset, FLUSH_PKT, parseFetchRequest, parsePack, parsePktLines, pktLine, sidebandEncode, ZERO_OID } from './gitcore.ts';
import { NotFoundError, Store, commitParents } from './store.ts';
import { isOid } from './util.ts';

const DELIM_PKT = Buffer.from('0001', 'ascii');

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitHttpResult {
  return { status: 200, contentType, body };
}

function notFound(message: string): GitHttpResult {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    'agent=github-forge-v02/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'server-option\n',
  ];
  const parts: Buffer[] = [pktLine(lines[0]), FLUSH_PKT];
  for (const line of lines.slice(1)) parts.push(pktLine(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** The v0 ref advertisement for receive-pack. */
function v0ReceiveAdvertisement(store: Store, repoFullName: string): Buffer {
  const repo = store.repos.get(repoFullName);
  const headRef = repo ? store.headRef(repo) : 'refs/heads/main';
  const capabilities = [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    'agent=github-forge-v02/1.0',
    `symref=HEAD:${headRef}`,
  ].join(' ');
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH_PKT];
  if (!repo || repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = repo.refs.get(headRef) ?? ZERO_OID;
    const refNames = [...repo.refs.keys()].sort();
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const ref of refNames) {
      const oid = repo.refs.get(ref) as string;
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const peeled = store.peelToCommit(repo, oid);
        if (peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string): GitHttpResult {
  const fullName = `${owner}/${repoName}`;
  if (!store.repos.has(fullName)) return notFound(`Repository ${fullName} not found`);
  if (service === 'git-upload-pack') {
    return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0ReceiveAdvertisement(store, fullName));
  }
  return notFound(`Unknown service ${service}`);
}

/** List refs for a v2 ls-refs request, honouring peel / symrefs / unborn / ref-prefix. */
function handleLsRefs(store: Store, repoFullName: string, body: Buffer): GitHttpResult {
  const repo = store.repos.get(repoFullName) as NonNullable<ReturnType<Store['getRepo']>>;
  // The request body is: command=ls-refs, delim, then argument lines, then flush.
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of parsePktLines(body)) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text === 'command=ls-refs') continue;
    if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const headRef = store.headRef(repo);
  const headOid = repo.refs.get(headRef);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headOid === undefined) {
    // Unborn HEAD: the client reads the first token `unborn`.
    if (keep('HEAD') && unborn) {
      const attrs = symrefs ? ` symref-target:${headRef}` : '';
      parts.push(pktLine(`unborn HEAD${attrs}\n`));
    }
  } else {
    if (keep('HEAD')) {
      const attrs = symrefs ? ` symref-target:${headRef}` : '';
      parts.push(pktLine(`${headOid} HEAD${attrs}\n`));
    }
  }
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!keep(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const peeled = store.peelToCommit(repo, oid);
        if (peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** Answer a v2 fetch: acknowledgments, shallow-info, and a sideband-framed packfile. */
function handleFetch(store: Store, repoFullName: string, body: Buffer): GitHttpResult {
  const repo = store.repos.get(repoFullName) as NonNullable<ReturnType<Store['getRepo']>>;
  const sections = parseFetchRequest(body);
  const wants = (sections.get('want') ?? []).filter(isOid);
  const haves = (sections.get('have') ?? []).filter(isOid);
  // The client sends `deepen N` for both a depth-N fetch and a deepen-N fetch; a deepen fetch
  // additionally names its current shallow boundaries in `shallow` lines.
  const deepenValues = sections.get('deepen') ?? [];
  const fetchDeepen = deepenValues.length ? Number.parseInt(deepenValues[0] as string, 10) : undefined;
  const shallowBoundaries = (sections.get('shallow') ?? []).filter(isOid);
  const sendSet = store.computeSendSet(repo, wants, haves, undefined, fetchDeepen, shallowBoundaries);
  const parts: Buffer[] = [];

  // Acknowledgments: ACK every have the server holds, then `ready`; NAK when nothing matches.
  const ackLines: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) ackLines.push(`ACK ${have}\n`);
  }
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (ackLines.length === 0) parts.push(pktLine('NAK\n'));
    for (const line of ackLines) parts.push(pktLine(line));
    parts.push(pktLine('ready\n'));
    parts.push(DELIM_PKT);
  }

  // Shallow-info: new shallow boundaries and haves that stopped being shallow.
  if (sendSet.shallow.length > 0 || sendSet.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of sendSet.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sendSet.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }

  // Packfile: sideband-framed; omitted entirely when there is nothing new to send.
  if (sendSet.objects.length > 0) {
    const pack = buildPack(sendSet.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandEncode(pack));
  }
  parts.push(FLUSH_PKT);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitHttpResult {
  const fullName = `${owner}/${repoName}`;
  if (!store.repos.has(fullName)) return notFound(`Repository ${fullName} not found`);
  const sections = parseFetchRequest(body);
  const command = (sections.get('command') ?? [])[0];
  if (command === 'ls-refs') return handleLsRefs(store, fullName, body);
  if (command === 'fetch') return handleFetch(store, fullName, body);
  return notFound(`Unknown upload-pack command ${command ?? ''}`);
}

/** Answer a v0 receive-pack push: store the pack, apply the ref updates, report per ref. */
export async function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): Promise<GitHttpResult> {
  const fullName = `${owner}/${repoName}`;
  const repo = store.repos.get(fullName);
  if (!repo) return notFound(`Repository ${fullName} not found`);

  // Split the body at the first flush packet: ref lines before it, the pack after it.
  const flushOffset = findFlushOffset(body);
  const headerBytes = flushOffset === -1 ? body : body.subarray(0, flushOffset);
  const commands: Array<{ oldOid: string; newOid: string; ref: string; capabilities: string[] }> = [];
  for (const packet of parsePktLines(headerBytes)) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const capabilities = nul >= 0 ? text.slice(nul + 1).trim().split(/\s+/).filter(Boolean) : [];
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(head.trim());
    if (match) {
      commands.push({
        oldOid: match[1] as string,
        newOid: match[2] as string,
        ref: match[3] as string,
        capabilities,
      });
    }
  }
  const wantsSideband = commands.some((command) => command.capabilities.includes('side-band-64k'));

  const reportLines: string[] = [];
  const packBytes = flushOffset === -1 ? Buffer.alloc(0) : body.subarray(flushOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasPack = packBytes.length > 0;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasPack) {
    try {
      const objects = await parsePack(packBytes);
      store.putObjects(repo, objects.map((obj) => ({ type: obj.type, data: obj.data, oid: obj.oid })));
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
    }
  } else if (updatesRef) {
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }

  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} remote ref does not match\n`);
        } else if (store.deleteRef(repo, command.ref)) {
          reportLines.push(`ok ${command.ref}\n`);
        } else {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        }
        continue;
      }
      if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} remote ref does not match\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID && current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid !== ZERO_OID && !isAncestor(store, repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      store.setRef(repo, command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
    }
  }

  let responseBody: Buffer;
  if (wantsSideband) {
    const inner = Buffer.concat([pktLine(`unpack ${unpackDetail}\n`), ...reportLines.map((line) => pktLine(line)), FLUSH_PKT]);
    responseBody = sidebandEncode(inner);
  } else {
    responseBody = Buffer.concat([pktLine(`unpack ${unpackDetail}\n`), ...reportLines.map((line) => pktLine(line)), FLUSH_PKT]);
  }
  return ok('application/x-git-receive-pack-result', responseBody);
}

/** True when `ancestor` is reachable from `descendant` (or equal to it). */
function isAncestor(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    for (const parent of commitParents(commit.data)) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}
