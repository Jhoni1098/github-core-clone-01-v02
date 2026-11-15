// The domain store: repositories, git objects, refs, issues, pull requests, comments and labels,
// held in memory for O(1) reads and persisted to a single append-only journal (see journal.ts).
//
// Every mutation appends its records in one writeSync, then updates the in-memory index. On boot
// the journal is replayed front to back, so the index is rebuilt exactly. Deterministic
// timestamps come from a tick clock (a base epoch plus a counter), never from Date.now().

import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, RECORD_TYPES, type JournalRecord, type RecordType } from './journal.ts';
import {
  buildCommit,
  buildPack,
  buildTree,
  emptyTree,
  hashObject,
  makeObject,
  parseCommit,
  parseTree,
  EMPTY_TREE_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { VIEWER } from './scenario.ts';
import { b64decode, b64encode, isOid, ZERO_OID } from './util.ts';

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
}

export interface IssueRecord {
  id: number;
  number: number;
  repoFullName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface PullRecord {
  id: number;
  number: number;
  repoFullName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommentRecord {
  id: number;
  repoFullName: string;
  issueNumber: number;
  body: string;
  userLogin: string;
  createdAt: number;
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export class NotFoundError extends Error {}
export class AlreadyExistsError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

export interface Repo {
  record: RepoRecord;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  comments: Map<number, CommentRecord>;
  nextNumber: number;
  nextCommentId: number;
}

const BASE_EPOCH_SECONDS = 1_700_000_000;

/** Deterministic clock: a base epoch plus one second per tick. */
class TickClock {
  #tick = 0;
  now(): number {
    this.#tick += 1;
    return BASE_EPOCH_SECONDS + this.#tick;
  }
  nowIso(): string {
    return new Date(this.now() * 1000).toISOString();
  }
}

export interface SendSet {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

export class Store {
  readonly journal: Journal;
  readonly clock = new TickClock();
  readonly repos = new Map<string, Repo>();
  #nextRepoId = 1;
  #nextGlobalId = 1;

  constructor(dataDir?: string) {
    const directory = dataDir ?? resolveDataDir();
    mkdirSync(directory, { recursive: true });
    this.journal = new Journal(directory);
    this.replay();
  }

  /* ---------------- persistence ---------------- */

  private replay(): void {
    for (const record of this.journal.scan()) {
      this.applyRecord(record, false);
    }
  }

  private applyRecord(record: JournalRecord, live: boolean): void {
    const p = record.payload as Record<string, any>;
    switch (record.type) {
      case RECORD_TYPES.repo: {
        const repo: Repo = {
          record: {
            id: p.id, owner: p.owner, name: p.name, fullName: p.fullName,
            description: p.description, private: p.private, defaultBranch: p.defaultBranch,
            createdAt: p.createdAt, updatedAt: p.updatedAt,
          },
          objects: new Map(), refs: new Map(), labels: new Map(),
          issues: new Map(), pulls: new Map(), comments: new Map(),
          nextNumber: 1, nextCommentId: 1,
        };
        this.repos.set(p.fullName, repo);
        if (p.id >= this.#nextRepoId) this.#nextRepoId = p.id + 1;
        break;
      }
      case RECORD_TYPES.object: {
        const repo = this.repos.get(p.repo as string);
        if (!repo) break;
        const data = b64decode(p.data as string);
        repo.objects.set(p.oid as string, { type: p.objType as GitObjectType, data, oid: p.oid as string });
        break;
      }
      case RECORD_TYPES.ref: {
        const repo = this.repos.get(p.repo as string);
        if (!repo) break;
        if (p.oid === ZERO_OID) repo.refs.delete(p.ref as string);
        else repo.refs.set(p.ref as string, p.oid as string);
        break;
      }
      case RECORD_TYPES.issue: {
        const repo = this.repos.get(p.repo as string);
        if (!repo) break;
        const issue: IssueRecord = {
          id: p.id, number: p.number, repoFullName: p.repo, title: p.title, body: p.body,
          state: p.state, labels: p.labels ?? [], userLogin: p.userLogin,
          createdAt: p.createdAt, updatedAt: p.updatedAt, closedAt: p.closedAt ?? null,
        };
        repo.issues.set(issue.number, issue);
        if (issue.number >= repo.nextNumber) repo.nextNumber = issue.number + 1;
        if (issue.id >= this.#nextGlobalId) this.#nextGlobalId = issue.id + 1;
        break;
      }
      case RECORD_TYPES.pull: {
        const repo = this.repos.get(p.repo as string);
        if (!repo) break;
        const pull: PullRecord = {
          id: p.id, number: p.number, repoFullName: p.repo, title: p.title, body: p.body,
          state: p.state, merged: p.merged, mergedAt: p.mergedAt ?? null,
          mergeCommitSha: p.mergeCommitSha ?? null, headRef: p.headRef, baseRef: p.baseRef,
          userLogin: p.userLogin, createdAt: p.createdAt, updatedAt: p.updatedAt,
        };
        repo.pulls.set(pull.number, pull);
        if (pull.number >= repo.nextNumber) repo.nextNumber = pull.number + 1;
        if (pull.id >= this.#nextGlobalId) this.#nextGlobalId = pull.id + 1;
        break;
      }
      case RECORD_TYPES.comment: {
        const repo = this.repos.get(p.repo as string);
        if (!repo) break;
        const comment: CommentRecord = {
          id: p.id, repoFullName: p.repo, issueNumber: p.issueNumber, body: p.body,
          userLogin: p.userLogin, createdAt: p.createdAt,
        };
        repo.comments.set(comment.id, comment);
        if (comment.id >= repo.nextCommentId) repo.nextCommentId = comment.id + 1;
        break;
      }
      case RECORD_TYPES.label: {
        const repo = this.repos.get(p.repo as string);
        if (!repo) break;
        repo.labels.set(p.name as string, { name: p.name, color: p.color, description: p.description ?? '' });
        break;
      }
      case RECORD_TYPES.meta: {
        if (typeof p.nextRepoId === 'number') this.#nextRepoId = Math.max(this.#nextRepoId, p.nextRepoId);
        if (typeof p.nextGlobalId === 'number') this.#nextGlobalId = Math.max(this.#nextGlobalId, p.nextGlobalId);
        break;
      }
      case RECORD_TYPES.deleteRepo: {
        this.repos.delete(p.fullName as string);
        break;
      }
      default:
        break;
    }
    void live;
  }

  private persist(records: readonly { type: RecordType; payload: Record<string, unknown> }[]): void {
    this.journal.appendMany(records);
  }

  /** Live records for compaction: the current state, replayed into the same index. */
  snapshotRecords(): JournalRecord[] {
    const records: JournalRecord[] = [];
    records.push({
      type: RECORD_TYPES.meta,
      payload: { nextRepoId: this.#nextRepoId, nextGlobalId: this.#nextGlobalId },
    });
    for (const repo of this.repos.values()) {
      const r = repo.record;
      records.push({ type: RECORD_TYPES.repo, payload: { ...r } });
      for (const obj of repo.objects.values()) {
        records.push({
          type: RECORD_TYPES.object,
          payload: { repo: r.fullName, oid: obj.oid, objType: obj.type, data: b64encode(obj.data) },
        });
      }
      for (const [ref, oid] of repo.refs) {
        records.push({ type: RECORD_TYPES.ref, payload: { repo: r.fullName, ref, oid } });
      }
      for (const label of repo.labels.values()) {
        records.push({ type: RECORD_TYPES.label, payload: { repo: r.fullName, ...label } });
      }
      for (const issue of repo.issues.values()) {
        records.push({ type: RECORD_TYPES.issue, payload: { repo: r.fullName, ...issue } });
      }
      for (const pull of repo.pulls.values()) {
        records.push({ type: RECORD_TYPES.pull, payload: { repo: r.fullName, ...pull } });
      }
      for (const comment of repo.comments.values()) {
        records.push({ type: RECORD_TYPES.comment, payload: { repo: r.fullName, ...comment } });
      }
    }
    return records;
  }

  maybeCompact(): void {
    if (this.journal.needsCompaction()) this.journal.compact(this.snapshotRecords());
  }

  /* ---------------- repos ---------------- */

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const fullName = `${owner}/${name}`;
    if (this.repos.has(fullName)) throw new AlreadyExistsError(`Repository ${fullName} already exists`);
    const now = this.clock.now();
    const id = this.#nextRepoId;
    this.#nextRepoId += 1;
    const record: RepoRecord = {
      id, owner, name, fullName, description, private: isPrivate,
      defaultBranch: 'main', createdAt: now, updatedAt: now,
    };
    const repo: Repo = {
      record, objects: new Map(), refs: new Map(), labels: new Map(),
      issues: new Map(), pulls: new Map(), comments: new Map(), nextNumber: 1, nextCommentId: 1,
    };
    for (const [labelName, color] of DEFAULT_LABELS) {
      repo.labels.set(labelName, { name: labelName, color, description: '' });
    }
    this.repos.set(fullName, repo);
    const records: { type: RecordType; payload: Record<string, unknown> }[] = [
      { type: RECORD_TYPES.repo, payload: { ...record } },
      { type: RECORD_TYPES.meta, payload: { nextRepoId: this.#nextRepoId, nextGlobalId: this.#nextGlobalId } },
    ];
    for (const label of repo.labels.values()) {
      records.push({ type: RECORD_TYPES.label, payload: { repo: fullName, ...label } });
    }
    this.persist(records);
    return repo;
  }

  getRepo(owner: string, name: string): Repo {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new NotFoundError(`Repository ${owner}/${name} not found`);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const fullName = `${owner}/${name}`;
    if (!this.repos.has(fullName)) throw new NotFoundError(`Repository ${fullName} not found`);
    this.repos.delete(fullName);
    this.persist([{ type: RECORD_TYPES.deleteRepo, payload: { fullName } }]);
  }

  listReposByOwner(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.record.owner === owner)
      .sort((a, b) => a.record.id - b.record.id);
  }

  /* ---------------- objects & refs ---------------- */

  putObject(repo: Repo, obj: GitObject): void {
    if (repo.objects.has(obj.oid)) return;
    repo.objects.set(obj.oid, obj);
    this.persist([{
      type: RECORD_TYPES.object,
      payload: { repo: repo.record.fullName, oid: obj.oid, objType: obj.type, data: b64encode(obj.data) },
    }]);
  }

  putObjects(repo: Repo, objects: readonly GitObject[]): void {
    const fresh = objects.filter((obj) => !repo.objects.has(obj.oid));
    if (!fresh.length) return;
    for (const obj of fresh) repo.objects.set(obj.oid, obj);
    this.persist(fresh.map((obj) => ({
      type: RECORD_TYPES.object as RecordType,
      payload: { repo: repo.record.fullName, oid: obj.oid, objType: obj.type, data: b64encode(obj.data) },
    })));
  }

  getObject(repo: Repo, oid: string): GitObject {
    const obj = repo.objects.get(oid);
    if (!obj) throw new NotFoundError(`Object ${oid} not found`);
    return obj;
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.record.updatedAt = this.clock.now();
    this.persist([{ type: RECORD_TYPES.ref, payload: { repo: repo.record.fullName, ref, oid } }]);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    if (!repo.refs.has(ref)) return false;
    repo.refs.delete(ref);
    this.persist([{ type: RECORD_TYPES.ref, payload: { repo: repo.record.fullName, ref, oid: ZERO_OID } }]);
    return true;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.record.defaultBranch}`;
  }

  headOid(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** Peel a tag object to its target commit (recursively, for nested tags). */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tag') return current;
      const fields = parseCommit(obj.data);
      const target = fields.get('object');
      if (!target || !isOid(target)) return current;
      current = target;
    }
    return current;
  }

  /* ---------------- reachability & send sets ---------------- */

  /** All objects reachable from the given commit tips, stopping at (and excluding) stopOids. */
  collectReachable(repo: Repo, tips: readonly string[], stopOids: ReadonlySet<string> = new Set()): Map<string, GitObject> {
    const found = new Map<string, GitObject>();
    const commitQueue: string[] = [];
    const seenCommits = new Set<string>();
    for (const tip of tips) {
      if (stopOids.has(tip)) continue;
      const obj = repo.objects.get(tip);
      if (!obj) continue;
      if (obj.type === 'commit') commitQueue.push(tip);
      else if (obj.type === 'tag') {
        const peeled = this.peelToCommit(repo, tip);
        if (!stopOids.has(peeled)) commitQueue.push(peeled);
        found.set(tip, obj);
      } else {
        found.set(tip, obj);
      }
    }
    while (commitQueue.length) {
      const oid = commitQueue.pop() as string;
      if (seenCommits.has(oid) || stopOids.has(oid)) continue;
      seenCommits.add(oid);
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      found.set(oid, commit);
      const fields = parseCommit(commit.data);
      const treeOid = fields.get('tree');
      if (treeOid) this.collectTree(repo, treeOid, found);
      // Parents are listed as repeated `parent` lines; parseCommit keeps the first only, so scan raw.
      for (const parent of commitParents(commit.data)) {
        if (!stopOids.has(parent) && !seenCommits.has(parent)) commitQueue.push(parent);
      }
    }
    return found;
  }

  private collectTree(repo: Repo, treeOid: string, found: Map<string, GitObject>): void {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree' || found.has(treeOid)) return;
    found.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = repo.objects.get(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') this.collectTree(repo, entry.oid, found);
      else found.set(entry.oid, child);
    }
  }

  /** Commits reachable from tips within `maxDepth` steps (tip = depth 1).
   *
   * Haves are traversal-transparent: the walk passes through them (a deepen fetch names its own
   * shallow tip as both a want and a have), but they are never sent. A sent commit is shallow
   * when it has a parent that is neither sent nor already held by the client. */
  collectShallow(repo: Repo, tips: readonly string[], maxDepth: number, stopOids: ReadonlySet<string>): { commits: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const commits = new Map<string, GitObject>();
    const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 1 }));
    const seen = new Set<string>();
    const walkedHaves = new Set<string>();
    while (queue.length) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (seen.has(oid) || depth > maxDepth) continue;
      seen.add(oid);
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      if (stopOids.has(oid)) walkedHaves.add(oid);
      else commits.set(oid, commit);
      if (depth < maxDepth) {
        for (const parent of commitParents(commit.data)) {
          if (!seen.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
        }
      }
    }
    const shallow: string[] = [];
    for (const oid of commits.keys()) {
      const commit = commits.get(oid) as GitObject;
      const parents = commitParents(commit.data);
      if (parents.length === 0) continue;
      if (parents.some((parent) => !commits.has(parent) && !stopOids.has(parent))) shallow.push(oid);
    }
    return { commits, shallow, unshallow: [...walkedHaves] };
  }

  /** Everything the client already holds: the have commits, their trees, and their ancestors —
   * except that the walk never descends past a shallow boundary (the client holds the boundary
   * commit and its tree, but not its parents). */
  collectHeld(repo: Repo, haves: readonly string[], boundaries: ReadonlySet<string> = new Set()): Map<string, GitObject> {
    const held = new Map<string, GitObject>();
    const queue: string[] = [...haves];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        held.set(oid, obj);
        const treeOid = parseCommit(obj.data).get('tree');
        if (treeOid) this.collectTree(repo, treeOid, held);
        // Never descend past a shallow boundary: the client holds the boundary commit and its
        // tree, but none of its parents.
        if (!boundaries.has(oid)) {
          for (const parent of commitParents(obj.data)) {
            if (!boundaries.has(parent)) queue.push(parent);
          }
        }
      } else if (obj.type === 'tag') {
        held.set(oid, obj);
        const peeled = this.peelToCommit(repo, oid);
        if (!boundaries.has(peeled)) queue.push(peeled);
      } else {
        held.set(oid, obj);
      }
    }
    return held;
  }

  /** The send set for a fetch: wants, haves, optional depth / deepen. */
  computeSendSet(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth?: number,
    deepen?: number,
    shallowBoundaries: readonly string[] = [],
  ): SendSet {
    const haveSet = new Set(haves.filter((oid) => repo.objects.has(oid)));
    const wantTips = wants.filter((oid) => repo.objects.has(oid));
    const boundarySet = new Set(shallowBoundaries.filter((oid) => repo.objects.has(oid)));
    const held = this.collectHeld(repo, [...haveSet], boundarySet);
    if (depth != null || deepen != null) {
      const maxDepth = depth ?? deepen ?? 1;
      const { commits, shallow, unshallow } = this.collectShallow(repo, wantTips, maxDepth, haveSet);
      const objects = new Map<string, GitObject>();
      for (const commit of commits.values()) {
        objects.set(commit.oid, commit);
        const treeOid = parseCommit(commit.data).get('tree');
        if (treeOid) this.collectTree(repo, treeOid, objects);
      }
      for (const oid of held.keys()) objects.delete(oid);
      return { objects: [...objects.values()], shallow, unshallow };
    }
    const reachable = this.collectReachable(repo, wantTips, haveSet);
    for (const oid of held.keys()) reachable.delete(oid);
    return { objects: [...reachable.values()], shallow: [], unshallow: [] };
  }

  /** The merge-base of two commits: the first common ancestor found by breadth-first descent. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsA = new Map<string, number>();
    const queueA: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
    while (queueA.length) {
      const { oid, depth } = queueA.shift() as { oid: string; depth: number };
      if (ancestorsA.has(oid)) continue;
      ancestorsA.set(oid, depth);
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      for (const parent of commitParents(commit.data)) queueA.push({ oid: parent, depth: depth + 1 });
    }
    const queueB: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    while (queueB.length) {
      const { oid, depth } = queueB.shift() as { oid: string; depth: number };
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const depthA = ancestorsA.get(oid);
      if (depthA !== undefined && depthA + depth < bestDepth) {
        best = oid;
        bestDepth = depthA + depth;
      }
      if (depth + 1 >= bestDepth) continue;
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      for (const parent of commitParents(commit.data)) queueB.push({ oid: parent, depth: depth + 1 });
    }
    return best;
  }

  /* ---------------- trees & contents ---------------- */

  /** Flatten a tree into path → entry, recursively. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, TreeEntry & { type: GitObjectType }> {
    const out = new Map<string, TreeEntry & { type: GitObjectType }>();
    const walk = (oid: string, pathPrefix: string): void => {
      const tree = repo.objects.get(oid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        const child = repo.objects.get(entry.oid);
        if (entry.mode === '40000' || child?.type === 'tree') {
          out.set(path, { ...entry, type: 'tree' });
          walk(entry.oid, path);
        } else {
          out.set(path, { ...entry, type: child?.type ?? 'blob' });
        }
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree object from a flat path map, creating intermediate trees bottom-up. */
  buildTreeFromMap(repo: Repo, files: Map<string, { mode: string; oid: string }>): { rootOid: string; created: GitObject[] } {
    const created: GitObject[] = [];
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Set<string>();
      for (const [path, file] of files) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          subdirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of [...subdirs].sort()) {
        const childPrefix = prefix ? `${prefix}/${dir}` : dir;
        entries.push({ mode: '40000', name: dir, oid: buildDir(childPrefix) });
      }
      const tree = makeObject('tree', buildTree(entries));
      if (!repo.objects.has(tree.oid)) created.push(tree);
      return tree.oid;
    };
    return { rootOid: buildDir(''), created };
  }

  /** The tree a ref points at (following the commit), or the empty tree for an unborn ref. */
  treeOidForRef(repo: Repo, ref: string): string {
    const oid = repo.refs.get(ref);
    if (!oid) return EMPTY_TREE_OID;
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(commit.data).get('tree') ?? EMPTY_TREE_OID;
  }

  /** Create a commit on a branch with the given tree and message; returns the commit object. */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): GitObject {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const author = forgeIdentity(this.clock.now());
    const commit = makeObject('commit', buildCommit(
      { tree: treeOid, parents: parent ? [parent] : [], message },
      author,
    ));
    this.putObject(repo, commit);
    this.setRef(repo, ref, commit.oid);
    return commit;
  }

  /** Apply a contents PUT/DELETE to a branch: returns the new commit. */
  applyContentChange(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): GitObject {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const baseTreeOid = this.treeOidForRef(repo, ref);
    const flat = this.flattenTree(repo, baseTreeOid);
    const existing = flat.get(path);
    if (content === null) {
      if (!existing) throw new NotFoundError(`Path ${path} not found`);
      if (expectedSha && existing.oid !== expectedSha) throw new ConflictError('sha does not match the current blob');
      flat.delete(path);
    } else {
      if (expectedSha) {
        if (!existing) throw new NotFoundError(`Path ${path} not found`);
        if (existing.oid !== expectedSha) throw new ConflictError('sha does not match the current blob');
      }
      const blob = makeObject('blob', content);
      this.putObject(repo, blob);
      flat.set(path, { mode: '100644', name: path.split('/').pop() as string, oid: blob.oid, type: 'blob' });
    }
    const files = new Map<string, { mode: string; oid: string }>();
    for (const [filePath, entry] of flat) {
      if (entry.type === 'blob') files.set(filePath, { mode: entry.mode, oid: entry.oid });
    }
    const { rootOid, created } = this.buildTreeFromMap(repo, files);
    this.putObjects(repo, created);
    return this.commitOnBranch(repo, branch, rootOid, message);
  }

  /* ---------------- issues ---------------- */

  createIssue(repo: Repo, title: string, body: string, labels: string[], userLogin: string): IssueRecord {
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new ValidationError(`Label ${label} does not exist`);
    }
    const now = this.clock.now();
    const issue: IssueRecord = {
      id: this.#nextGlobalId, number: repo.nextNumber, repoFullName: repo.record.fullName,
      title, body, state: 'open', labels: [...labels], userLogin,
      createdAt: now, updatedAt: now, closedAt: null,
    };
    this.#nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    this.persist([
      { type: RECORD_TYPES.issue, payload: { repo: repo.record.fullName, ...issue } },
      { type: RECORD_TYPES.meta, payload: { nextRepoId: this.#nextRepoId, nextGlobalId: this.#nextGlobalId } },
    ]);
    return issue;
  }

  getIssue(repo: Repo, number: number): IssueRecord {
    const issue = repo.issues.get(number);
    if (!issue) throw new NotFoundError(`Issue #${number} not found`);
    return issue;
  }

  updateIssue(repo: Repo, number: number, patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] }): IssueRecord {
    const issue = this.getIssue(repo, number);
    if (patch.labels) {
      for (const label of patch.labels) {
        if (!repo.labels.has(label)) throw new ValidationError(`Label ${label} does not exist`);
      }
      issue.labels = [...patch.labels];
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? this.clock.now() : null;
    }
    issue.updatedAt = this.clock.now();
    this.persist([{ type: RECORD_TYPES.issue, payload: { repo: repo.record.fullName, ...issue } }]);
    return issue;
  }

  listIssues(repo: Repo, state?: string, sort: 'created' | 'updated' = 'created', direction: 'asc' | 'desc' = 'desc'): IssueRecord[] {
    let issues = [...repo.issues.values()];
    if (state && state !== 'all') issues = issues.filter((issue) => issue.state === state);
    const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
    issues.sort((a, b) => {
      const diff = a[key] - b[key] || a.number - b.number;
      return direction === 'asc' ? diff : -diff;
    });
    return issues;
  }

  createComment(repo: Repo, issueNumber: number, body: string, userLogin: string): CommentRecord {
    this.getIssue(repo, issueNumber);
    const comment: CommentRecord = {
      id: repo.nextCommentId, repoFullName: repo.record.fullName, issueNumber,
      body, userLogin, createdAt: this.clock.now(),
    };
    repo.nextCommentId += 1;
    repo.comments.set(comment.id, comment);
    this.persist([{ type: RECORD_TYPES.comment, payload: { repo: repo.record.fullName, ...comment } }]);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): CommentRecord[] {
    this.getIssue(repo, issueNumber);
    return [...repo.comments.values()]
      .filter((comment) => comment.issueNumber === issueNumber)
      .sort((a, b) => a.id - b.id);
  }

  createLabel(repo: Repo, name: string, color: string, description = ''): LabelRecord {
    const label: LabelRecord = { name, color, description };
    repo.labels.set(name, label);
    this.persist([{ type: RECORD_TYPES.label, payload: { repo: repo.record.fullName, ...label } }]);
    return label;
  }

  /* ---------------- pull requests ---------------- */

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, userLogin: string): PullRecord {
    const headOid = repo.refs.get(`refs/heads/${headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headOid) throw new ValidationError(`Head branch ${headRef} does not exist`);
    if (!baseOid) throw new ValidationError(`Base branch ${baseRef} does not exist`);
    const now = this.clock.now();
    const pull: PullRecord = {
      id: this.#nextGlobalId, number: repo.nextNumber, repoFullName: repo.record.fullName,
      title, body, state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headRef, baseRef, userLogin, createdAt: now, updatedAt: now,
    };
    this.#nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    this.persist([
      { type: RECORD_TYPES.pull, payload: { repo: repo.record.fullName, ...pull } },
      { type: RECORD_TYPES.meta, payload: { nextRepoId: this.#nextRepoId, nextGlobalId: this.#nextGlobalId } },
    ]);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRecord {
    const pull = repo.pulls.get(number);
    if (!pull) throw new NotFoundError(`Pull request #${number} not found`);
    return pull;
  }

  listPulls(repo: Repo, state?: string): PullRecord[] {
    let pulls = [...repo.pulls.values()];
    if (state && state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => b.number - a.number);
    return pulls;
  }

  /** Whether a pull request merges cleanly (MERGEABLE) or conflicts (CONFLICTING). */
  mergeable(repo: Repo, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headOid || !baseOid) return 'UNKNOWN';
    const base = this.mergeBase(repo, headOid, baseOid);
    if (base === null) return 'UNKNOWN';
    return this.threeWayConflict(repo, base, headOid, baseOid) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** True when the same path changed differently on both sides of the merge-base. */
  threeWayConflict(repo: Repo, baseCommit: string, headCommit: string, baseBranchCommit: string): boolean {
    const baseTree = this.treeOidForCommit(repo, baseCommit);
    const headTree = this.treeOidForCommit(repo, headCommit);
    const branchTree = this.treeOidForCommit(repo, baseBranchCommit);
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const branchFiles = this.flattenTree(repo, branchTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...branchFiles.keys()]);
    for (const path of paths) {
      const baseOid = baseFiles.get(path)?.oid;
      const headOid = headFiles.get(path)?.oid;
      const branchOid = branchFiles.get(path)?.oid;
      const headChanged = headOid !== baseOid;
      const branchChanged = branchOid !== baseOid;
      if (headChanged && branchChanged && headOid !== branchOid) return true;
    }
    return false;
  }

  /** The merged tree of a three-way merge (head's changes win where the base branch did not move). */
  threeWayMergeTree(repo: Repo, baseCommit: string, headCommit: string, baseBranchCommit: string): { rootOid: string; created: GitObject[] } {
    const baseTree = this.treeOidForCommit(repo, baseCommit);
    const headTree = this.treeOidForCommit(repo, headCommit);
    const branchTree = this.treeOidForCommit(repo, baseBranchCommit);
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const branchFiles = this.flattenTree(repo, branchTree);
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...branchFiles.keys()]);
    for (const path of paths) {
      const baseOid = baseFiles.get(path)?.oid;
      const headOid = headFiles.get(path)?.oid;
      const branchOid = branchFiles.get(path)?.oid;
      const headEntry = headFiles.get(path);
      const branchEntry = branchFiles.get(path);
      if (headOid === branchOid) {
        if (headOid !== undefined && headEntry) merged.set(path, { mode: headEntry.mode, oid: headOid });
      } else if (headOid === baseOid) {
        if (branchOid !== undefined && branchEntry) merged.set(path, { mode: branchEntry.mode, oid: branchOid });
      } else {
        // Head changed (and the base branch did not, or the caller already checked conflicts):
        // the head's version wins.
        if (headOid !== undefined && headEntry) merged.set(path, { mode: headEntry.mode, oid: headOid });
      }
    }
    return this.buildTreeFromMap(repo, merged);
  }

  /** Squash-merge a pull request onto its base branch; returns the merge commit. */
  mergePull(repo: Repo, number: number, mergeMethod: string): { pull: PullRecord; commit: GitObject } {
    const pull = this.getPull(repo, number);
    if (pull.state !== 'open') throw new ConflictError(`Pull request #${number} is not open`);
    if (mergeMethod !== 'squash' && mergeMethod !== 'SQUASH') throw new ValidationError(`Unsupported merge method ${mergeMethod}`);
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headOid || !baseOid) throw new NotFoundError('Pull request branch not found');
    const base = this.mergeBase(repo, headOid, baseOid);
    if (base === null) throw new ConflictError('No merge base');
    if (this.threeWayConflict(repo, base, headOid, baseOid)) {
      throw new ConflictError('Merge conflict');
    }
    const { rootOid, created } = this.threeWayMergeTree(repo, base, headOid, baseOid);
    this.putObjects(repo, created);
    const commit = this.commitOnBranch(repo, pull.baseRef, rootOid, pull.title);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.now();
    pull.mergeCommitSha = commit.oid;
    pull.updatedAt = this.clock.now();
    this.persist([{ type: RECORD_TYPES.pull, payload: { repo: repo.record.fullName, ...pull } }]);
    return { pull, commit };
  }

  /** File-level diff between the base and head of a pull request. */
  pullFiles(repo: Repo, pull: PullRecord): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headOid || !baseOid) return [];
    const base = this.mergeBase(repo, headOid, baseOid) ?? baseOid;
    const baseFiles = this.flattenTree(repo, this.treeOidForCommit(repo, base));
    const headFiles = this.flattenTree(repo, this.treeOidForCommit(repo, headOid));
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const baseEntry = baseFiles.get(path);
      const headEntry = headFiles.get(path);
      if (baseEntry?.oid === headEntry?.oid) continue;
      const status = !baseEntry ? 'added' : !headEntry ? 'removed' : 'modified';
      const oldText = baseEntry ? this.blobText(repo, baseEntry.oid) : '';
      const newText = headEntry ? this.blobText(repo, headEntry.oid) : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  private blobText(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'blob') return '';
    return obj.data.toString('utf8');
  }

  private treeOidForCommit(repo: Repo, commitOid: string): string {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(commit.data).get('tree') ?? EMPTY_TREE_OID;
  }

  /* ---------------- misc ---------------- */

  /** Build a pack of every object the given list names (in the given order). */
  buildPackFor(objects: readonly GitObject[]): Buffer {
    return buildPack(objects);
  }
}

const DEFAULT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
];

/** All parents of a commit, in order (parseCommit keeps only the first `parent` line). */
export function commitParents(data: Buffer): string[] {
  const headerEnd = data.indexOf('\n\n');
  const header = headerEnd === -1 ? data : data.subarray(0, headerEnd);
  const parents: string[] = [];
  for (const line of header.toString('utf8').split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return parents;
}

/** The fixed forge identity used for server-created commits (tick-clock time, never wall time). */
export function forgeIdentity(epochSeconds: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSeconds} +0000`;
}

function resolveDataDir(): string {
  if (process.env.FORGE_DATA_DIR) return process.env.FORGE_DATA_DIR;
  try {
    mkdirSync('./data', { recursive: true });
    return './data';
  } catch {
    return join(tmpdir(), 'github-forge-v02');
  }
}

/** Line diff by common prefix/suffix trimming: additions/deletions for one file. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length && prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}
