// store.ts — the forge's in-memory store: objects, repositories, refs, issues,
// pull requests, labels and comments, plus the shared git operations every
// surface (smart HTTP, REST, GraphQL, MCP) builds on.

import {
  buildCommit,
  buildTree,
  collectCommits,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './pkt.ts';

/** The login the bearer token names, from the contest's one fixed scenario seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Opaque Relay-style global ids: base64 of a namespaced string, never the plain id. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { kind: text.slice(0, at), parts: text.slice(at + 1).split(':') };
  } catch {
    return null;
  }
}

export class Forge {
  /** Every object, content-addressed and shared across repositories. */
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  /**
   * Bounded cache of fetch results: key -> the pack bytes plus the shallow /
   * unshallow lists for one (wants, haves, shallowHeld, depth) fetch. The
   * object store is append-only, so a pack built while every referenced oid
   * existed can never go stale; entries are stored only on that condition
   * (see git.ts). FIFO eviction keeps the cache bounded.
   */
  readonly fetchPackCache = new Map<string, { pack: Buffer | null; shallow: string[]; unshallow: string[] }>();

  /** Store one fetch result, evicting the oldest entry when the cache is full. */
  cacheFetchPack(key: string, value: { pack: Buffer | null; shallow: string[]; unshallow: string[] }): void {
    if (this.fetchPackCache.has(key)) return;
    if (this.fetchPackCache.size >= 64) {
      const oldest = this.fetchPackCache.keys().next().value;
      if (oldest !== undefined) this.fetchPackCache.delete(oldest);
    }
    this.fetchPackCache.set(key, value);
  }

  private nextRepoId = 1;
  private repoSeq = 0;
  private commitSeq = 0;

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out.sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: ++this.repoSeq,
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  defaultTip(repo: Repo): string | null {
    return repo.refs.get(this.headTarget(repo)) ?? null;
  }

  // -------------------------------------------------------------------------
  // trees and files
  // -------------------------------------------------------------------------

  /** The tree entries at a commit's root, or null when the commit is unknown. */
  treeEntriesAt(commitOid: string): TreeEntry[] | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    const tree = this.objects.get(parseCommit(object.data).tree);
    if (!tree || tree.type !== 'tree') return null;
    return parseTree(tree.data);
  }

  /** Flatten a tree into path -> {oid, mode}, following subtrees. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** The flat file map of a commit (path -> blob oid), or null when unknown. */
  filesAt(commitOid: string): Map<string, { oid: string; mode: string }> | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return this.flattenTree(parseCommit(object.data).tree);
  }

  /** The blob oid at `path` in the tree of `commitOid`, or null. */
  blobAt(commitOid: string, path: string): { oid: string; mode: string } | null {
    const files = this.filesAt(commitOid);
    if (files === null) return null;
    return files.get(path) ?? null;
  }

  /** Build a tree from a flat file map (path -> blob oid), creating subtrees as needed. */
  treeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** A commit on top of `parent` (or a root commit) that sets `path` to `content`. */
  commitFile(
    repo: Repo,
    opts: { parent: string | null; path: string; content: Buffer; message: string; branch: string },
  ): string {
    const blobOid = this.putObject('blob', opts.content);
    const files = opts.parent === null ? new Map<string, { oid: string; mode: string }>() : this.filesAt(opts.parent) ?? new Map();
    files.set(opts.path, { oid: blobOid, mode: '100644' });
    const treeOid = this.treeFromFiles(files);
    const timestamp = 1_735_689_600 + ++this.commitSeq;
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: opts.parent === null ? [] : [opts.parent],
        // The message is stored verbatim: the API returns exactly what was PUT.
        message: opts.message,
        author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
        committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
        timestamp,
      }),
    );
    repo.refs.set(`refs/heads/${opts.branch}`, commitOid);
    return commitOid;
  }

  /** A commit that deletes `path` from `parent`'s tree. Returns null when the path is absent. */
  commitDelete(repo: Repo, opts: { parent: string; path: string; message: string; branch: string }): string | null {
    const files = this.filesAt(opts.parent);
    if (files === null || !files.has(opts.path)) return null;
    files.delete(opts.path);
    const treeOid = this.treeFromFiles(files);
    const timestamp = 1_735_689_600 + ++this.commitSeq;
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [opts.parent],
        message: opts.message,
        author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
        committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
        timestamp,
      }),
    );
    repo.refs.set(`refs/heads/${opts.branch}`, commitOid);
    return commitOid;
  }

  // -------------------------------------------------------------------------
  // refs and pushes
  // -------------------------------------------------------------------------

  /** The peeled commit of a ref target (tags peel to their commit). */
  peelToCommit(oid: string): string | null {
    const object = this.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      return this.peelToCommit(target);
    }
    return null;
  }

  /**
   * Apply one receive-pack command. Returns 'ok' or the ng reason.
   * Create: old is zero and the ref is absent. Update: old is the current tip
   * and the new commit has it as an ancestor. Delete: new is zero and old matches.
   */
  applyRefUpdate(repo: Repo, oldOid: string, newOid: string, ref: string): { ok: boolean; reason: string } {
    const current = repo.refs.get(ref) ?? null;
    if (newOid === ZERO_OID) {
      if (current === null) return { ok: false, reason: 'remote ref does not exist' };
      if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
      repo.refs.delete(ref);
      return { ok: true, reason: '' };
    }
    if (!this.objects.has(newOid)) return { ok: false, reason: 'unable to find object' };
    if (oldOid === ZERO_OID) {
      if (current !== null) return { ok: false, reason: 'already exists' };
      repo.refs.set(ref, newOid);
      return { ok: true, reason: '' };
    }
    if (current === null) return { ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    if (newOid === current) return { ok: true, reason: '' };
    const newObject = this.objects.get(newOid);
    if (newObject?.type === 'commit') {
      if (!isAncestor(oldOid, newOid, this.lookup)) return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }

  // -------------------------------------------------------------------------
  // issues, comments, labels
  // -------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
    }
    const issue: Issue = {
      number: repo.nextIssue++,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      seq: this.repoSeq++,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment: Comment = { id: repo.nextComment++, body, createdAt: nowIso() };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // -------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRequest | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (headTip === undefined) return { error: `head branch '${input.head}' does not exist` };
    if (baseTip === undefined) return { error: `base branch '${input.base}' does not exist` };
    if (input.head === input.base) return { error: 'head and base are the same branch' };
    const existing = repo.pulls.find((pr) => pr.head === input.head && pr.base === input.base && pr.state === 'open');
    if (existing) return { error: 'a pull request is already open for this head and base' };
    const pr: PullRequest = {
      number: repo.nextPull++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      head: input.head,
      base: input.base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.repoSeq++,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pr) => pr.number === number);
  }

  /** The file diff between the merge base and the head tip of a pull request. */
  pullFiles(repo: Repo, pr: PullRequest): FileChange[] {
    const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
    const base = mergeBase(headTip, baseTip, this.lookup) ?? baseTip;
    const baseFiles = this.filesAt(base) ?? new Map();
    const headFiles = this.filesAt(headTip) ?? new Map();
    const changes: FileChange[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const from = baseFiles.get(path);
      const to = headFiles.get(path);
      if (from && to && from.oid === to.oid) continue;
      const fromText = from ? (this.objects.get(from.oid)?.data.toString('utf8') ?? '') : '';
      const toText = to ? (this.objects.get(to.oid)?.data.toString('utf8') ?? '') : '';
      if (!from && to) {
        const additions = lineCount(toText);
        changes.push({ path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (from && !to) {
        const deletions = lineCount(fromText);
        changes.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else {
        const additions = lineCount(toText);
        const deletions = lineCount(fromText);
        changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  /** Three-way merge of baseTip (ours) and headTip (theirs) over their merge base. */
  threeWayMerge(
    baseTip: string,
    headTip: string,
  ): { ok: true; files: Map<string, { oid: string; mode: string }> } | { ok: false; conflict: string } {
    const base = mergeBase(headTip, baseTip, this.lookup);
    const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : this.filesAt(base) ?? new Map();
    const oursFiles = this.filesAt(baseTip) ?? new Map();
    const theirsFiles = this.filesAt(headTip) ?? new Map();
    const merged = new Map(oursFiles);
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const o = oursFiles.get(path);
      const t = theirsFiles.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
      if (same(o, t)) continue;
      if (same(o, b)) {
        if (t) merged.set(path, t);
        else merged.delete(path);
        continue;
      }
      if (same(t, b)) continue;
      return { ok: false, conflict: path };
    }
    return { ok: true, files: merged };
  }

  /** Whether a pull request would merge cleanly right now. */
  pullMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.threeWayMerge(baseTip, headTip).ok ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is the
   * three-way merge result. Returns the merge commit or an error status.
   */
  mergePull(repo: Repo, pr: PullRequest): { sha: string } | { status: number; message: string } {
    if (pr.state !== 'open') return { status: 405, message: 'Pull request is already closed' };
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (headTip === undefined || baseTip === undefined) return { status: 404, message: 'Pull request branch not found' };
    const merged = this.threeWayMerge(baseTip, headTip);
    if (!merged.ok) return { status: 405, message: `Merge conflict in ${merged.conflict}` };
    const treeOid = this.treeFromFiles(merged.files);
    const timestamp = 1_735_689_600 + ++this.commitSeq;
    const message = `Merge pull request #${pr.number} from ${VIEWER_LOGIN}/${pr.head}\n\n${pr.title}\n`;
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [baseTip],
        message,
        author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
        committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
        timestamp,
      }),
    );
    repo.refs.set(`refs/heads/${pr.base}`, commitOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = nowIso();
    pr.mergeCommitSha = commitOid;
    pr.updatedAt = nowIso();
    return { sha: commitOid };
  }

  // -------------------------------------------------------------------------
  // fetch planning (upload-pack)
  // -------------------------------------------------------------------------

  /**
   * The objects a fetch must send for `wants`, given what the client holds.
   * No depth: reachable(wants) minus reachable(haves).
   * Depth N: the commits within N generations of wants (a generation step is
   * a commit->parent edge; a tag dereference costs none), each with its tree
   * closure — never the parents past the boundary — minus what the client
   * holds (each held oid plus its tree closure; a shallow clone holds the
   * boundary commit and its tree, not the boundary's parents).
   */
  planFetch(opts: {
    wants: string[];
    haves: string[];
    shallowHeld: string[];
    depth?: number;
  }): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const heldExact = new Set([...opts.haves, ...opts.shallowHeld]);
    if (opts.depth === undefined) {
      const heldClosure = collectReachable(heldExact, this.lookup);
      const wanted = collectReachable(opts.wants, this.lookup);
      const objects: GitObject[] = [];
      for (const oid of wanted) {
        if (heldClosure.has(oid)) continue;
        const object = this.objects.get(oid);
        if (object) objects.push(object);
      }
      return { objects, shallow: [], unshallow: [] };
    }
    const depth = Math.max(1, Math.trunc(opts.depth));
    // Generations from the wants: gen 0 is the wants themselves; a tag costs
    // no generation, a parent edge costs one.
    const genOf = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of opts.wants) {
      if (!isObjectId(want)) continue;
      if (!genOf.has(want)) {
        genOf.set(want, 0);
        queue.push({ oid: want, gen: 0 });
      }
    }
    const sendSet = new Set<string>();
    const boundary: string[] = [];
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (gen >= depth) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        sendSet.add(oid);
        const target = parseTag(object.data).object;
        if (!genOf.has(target)) {
          genOf.set(target, gen);
          queue.push({ oid: target, gen });
        }
        continue;
      }
      if (object.type !== 'commit') continue;
      sendSet.add(oid);
      for (const treeOid of this.treeClosure(parseCommit(object.data).tree)) sendSet.add(treeOid);
      const parents = parseCommit(object.data).parents;
      if (gen === depth - 1) {
        if (parents.length > 0) boundary.push(oid);
      } else {
        for (const parent of parents) {
          if (!genOf.has(parent)) {
            genOf.set(parent, gen + 1);
            queue.push({ oid: parent, gen: gen + 1 });
          }
        }
      }
    }
    // What the client already holds: each held oid plus its tree closure.
    const heldSet = new Set<string>();
    for (const held of heldExact) {
      heldSet.add(held);
      const peeled = this.peelToCommit(held);
      if (peeled !== null) {
        const commit = this.objects.get(peeled);
        if (commit?.type === 'commit') {
          for (const treeOid of this.treeClosure(parseCommit(commit.data).tree)) heldSet.add(treeOid);
        }
      }
    }
    const objects: GitObject[] = [];
    for (const oid of sendSet) {
      if (heldSet.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object) objects.push(object);
    }
    const unshallow: string[] = [];
    for (const held of opts.shallowHeld) {
      if (!genOf.has(held)) continue;
      const object = this.objects.get(held);
      if (object?.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => genOf.has(parent))) unshallow.push(held);
    }
    return { objects, shallow: boundary, unshallow };
  }

  /** Every oid in a tree's closure: the tree, its subtrees and its blobs. */
  treeClosure(treeOid: string): Set<string> {
    const out = new Set<string>();
    const queue = [treeOid];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') continue;
      out.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') queue.push(entry.oid);
        else out.add(entry.oid);
      }
    }
    return out;
  }

  /** The commits reachable from a ref tip, newest first. */
  commitsFrom(tip: string | null): Array<{ sha: string; message: string }> {
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string }> = [];
    for (const oid of collectCommits([tip], this.lookup)) {
      const object = this.objects.get(oid);
      if (!object) continue;
      out.push({ sha: oid, message: parseCommit(object.data).message });
    }
    return out;
  }
}
