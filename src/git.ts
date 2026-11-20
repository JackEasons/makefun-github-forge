// git.ts — git smart HTTP: info/refs advertisement (v0 and v2), ls-refs, fetch
// and receive-pack, following the client's protocol (v2 when advertised).

import type { Forge, Repo } from './store.ts';
import {
  decodePktLines,
  decodePktPrefix,
  hashObject,
  isObjectId,
  packetLines,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type Packet,
} from './pkt.ts';

export const AGENT = 'forge/1.0';

export type HandlerResult = {
  status: number;
  contentType: string;
  body: Buffer;
};

const text = (status: number, contentType: string, body: Buffer | string): HandlerResult => ({
  status,
  contentType,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
});

const json = (status: number, value: unknown): HandlerResult =>
  text(status, 'application/json; charset=utf-8', JSON.stringify(value));

const BAD_REQUEST = (): HandlerResult => json(400, { message: 'malformed pkt-line request' });

function parsePktOrBad(body: Buffer): Packet[] | null {
  try {
    return decodePktLines(body);
  } catch {
    return null;
  }
}

/** All refs of a repo, in the order git lists them: HEAD, branches, tags. */
export function listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
  const out: Array<{ ref: string; oid: string }> = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) out.push({ ref: 'HEAD', oid: headTip });
  for (const [ref, oid] of repo.refs) out.push({ ref, oid });
  out.sort((a, b) => (a.ref === 'HEAD' ? -1 : b.ref === 'HEAD' ? 1 : a.ref < b.ref ? -1 : 1));
  return out;
}

/** The ref the client asked for, from a path like /<owner>/<repo>.git/<rest>. */
export function splitGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  return { owner: match[1], repo: match[2], rest: match[3] ?? '' };
}

function v0Advertise(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const isUpload = service === 'git-upload-pack';
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const capsUpload =
    'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=forge/1.0';
  const capsReceive = 'report-status side-band-64k delete-refs agent=forge/1.0';
  const refs = listRefs(repo);
  if (isUpload) {
    const prefix = headTip ?? ZERO_OID;
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsUpload}\n`));
    } else {
      for (const [index, ref] of refs.entries()) {
        if (index === 0) {
          lines.push(pktLine(`${ref.oid} ${ref.ref}\0${capsUpload}\n`));
          continue;
        }
        lines.push(pktLine(`${ref.oid} ${ref.ref}\n`));
        if (ref.ref.startsWith('refs/tags/')) {
          const peeled = forge.peelToCommit(ref.oid);
          if (peeled !== null && peeled !== ref.oid) lines.push(pktLine(`${peeled} ${ref.ref}^{}\n`));
        }
      }
    }
    lines.push(pktFlush());
  } else {
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsReceive}\n`));
    } else {
      for (const [index, ref] of refs.entries()) {
        if (index === 0) lines.push(pktLine(`${ref.oid} ${ref.ref}\0${capsReceive}\n`));
        else lines.push(pktLine(`${ref.oid} ${ref.ref}\n`));
      }
    }
    lines.push(pktFlush());
  }
  return Buffer.concat(lines);
}

function v2Advertise(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** Sideband band-1: pack bytes in chunks of at most 65515 bytes after the band byte. */
export function sidebandPack(pack: Buffer): Buffer {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(packets);
}

/**
 * The pack bytes plus shallow/unshallow lists for one fetch, reusing the
 * Forge's bounded cache when the same (wants, haves, shallowHeld, depth) is
 * fetched again — the clone workload fetches the identical depth-1 tip over
 * a hundred times, and planFetch + writePack is the most expensive work the
 * server does per clone. A result is stored only when every referenced oid
 * already exists in the store; the store is append-only, so a stored pack
 * can never go stale. A cache hit means identical inputs, hence identical
 * bytes, for both v0 and v2.
 */
function fetchPackFor(
  forge: Forge,
  wants: string[],
  haves: string[],
  shallowHeld: string[],
  depth: number | undefined,
): { pack: Buffer | null; shallow: string[]; unshallow: string[] } {
  const key = `${wants.join(',')}|${haves.join(',')}|${shallowHeld.join(',')}|${depth ?? ''}`;
  const hit = forge.fetchPackCache.get(key);
  if (hit) return hit;
  const plan = forge.planFetch({ wants, haves, shallowHeld, depth });
  const value = {
    pack: plan.objects.length > 0 ? writePack(plan.objects) : null,
    shallow: plan.shallow,
    unshallow: plan.unshallow,
  };
  const allExist = [...wants, ...haves, ...shallowHeld].every((oid) => forge.objects.has(oid));
  if (allExist) forge.cacheFetchPack(key, value);
  return value;
}

/**
 * Split a v2 request into its argument list. The request has two sections
 * separated by a delim packet: the first names the command (plus agent and
 * object-format), the second carries the command's arguments. Both sections
 * are merged into one flat list.
 */
function splitV2Commands(body: Buffer): { args: Array<{ key: string; value: string }> } {
  const args: Array<{ key: string; value: string }> = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    // Arguments come in three shapes: `key=value` (command=, agent=,
    // object-format=), `key value` (want, have, shallow, deepen, ref-prefix)
    // and bare flags (peel, symrefs, unborn, thin-pack, done).
    const eq = line.indexOf('=');
    if (eq >= 0) {
      args.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
      continue;
    }
    const space = line.indexOf(' ');
    if (space >= 0) {
      args.push({ key: line.slice(0, space), value: line.slice(space + 1) });
      continue;
    }
    args.push({ key: line, value: '' });
  }
  return { args };
}

function fetchObjectByOid(forge: Forge, oid: string): GitObject | undefined {
  return forge.lookup(oid);
}

export function handleGit(forge: Forge, request: {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
}): HandlerResult | null {
  const split = splitGitPath(request.pathname);
  if (!split) return null;
  const { owner, repo: repoName, rest } = split;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    if (rest === 'info/refs' || rest === 'git-upload-pack' || rest === 'git-receive-pack') {
      return json(404, { message: 'Not Found' });
    }
    return null;
  }

  if (rest === 'info/refs') {
    const service = request.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const wantsV2 = (request.headers.get('git-protocol') ?? '').split(' ').includes('version=2');
      if (wantsV2) return text(200, 'application/x-git-upload-pack-advertisement', v2Advertise());
      return text(200, 'application/x-git-upload-pack-advertisement', v0Advertise(forge, repo, 'git-upload-pack'));
    }
    if (service === 'git-receive-pack') {
      return text(200, 'application/x-git-receive-pack-advertisement', v0Advertise(forge, repo, 'git-receive-pack'));
    }
    return json(400, { message: 'service is required' });
  }

  if (rest === 'git-upload-pack') {
    return handleUploadPack(forge, repo, request.body);
  }

  if (rest === 'git-receive-pack') {
    return handleReceivePack(forge, repo, request.body);
  }

  return null;
}

function handleUploadPack(forge: Forge, repo: Repo, body: Buffer): HandlerResult {
  const packets = parsePktOrBad(body);
  if (packets === null) return BAD_REQUEST();
  const firstLine = packetLines(packets)[0] ?? '';
  // Protocol v2 requests start with `command=<name>`; v0 fetch requests start
  // with `want <oid>`. (`version 2` appears only in the advertisement.)
  if (firstLine.startsWith('command=') || firstLine.trim() === 'version 2') {
    return handleV2(forge, repo, body);
  }
  return handleV0Fetch(forge, repo, body);
}

function handleV2(forge: Forge, repo: Repo, body: Buffer): HandlerResult {
  const { args } = splitV2Commands(body);
  const command = args.find((arg) => arg.key === 'command')?.value ?? '';
  if (command === 'ls-refs') {
    const peel = args.some((arg) => arg.key === 'peel');
    const symrefs = args.some((arg) => arg.key === 'symrefs');
    const unborn = args.some((arg) => arg.key === 'unborn');
    const prefixes = args.filter((arg) => arg.key === 'ref-prefix').map((arg) => arg.value);
    const lines: string[] = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (headTip === null && unborn) {
      if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
        lines.push('unborn HEAD symref-target:refs/heads/main');
      }
    } else if (headTip !== null) {
      const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
      if (matches('HEAD') && symrefs) lines.push(`${headTip} HEAD symref-target:refs/heads/main`);
      const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      for (const [ref, oid] of sorted) {
        if (!matches(ref)) continue;
        const parts = [`${oid} ${ref}`];
        if (symrefs && ref === `refs/heads/${repo.defaultBranch}`) parts.push(`symref-target:${ref}`);
        if (peel && ref.startsWith('refs/tags/')) {
          const peeled = forge.peelToCommit(oid);
          if (peeled !== null && peeled !== oid) parts.push(`peeled:${peeled}`);
        }
        lines.push(parts.join(' '));
      }
    }
    return text(200, 'application/x-git-upload-pack-result', pktLines([...lines, 'flush']));
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowHeld: string[] = [];
    let deepen: number | undefined;
    for (const arg of args) {
      if (arg.key === 'want' && isObjectId(arg.value)) wants.push(arg.value);
      else if (arg.key === 'have' && isObjectId(arg.value)) haves.push(arg.value);
      else if (arg.key === 'shallow' && isObjectId(arg.value)) shallowHeld.push(arg.value);
      else if (arg.key === 'deepen' && /^\d+$/.test(arg.value)) deepen = Number(arg.value);
    }
    const plan = fetchPackFor(forge, wants, haves, shallowHeld, deepen);
    // The acknowledgments section is only sent when the client sent `have`
    // lines to acknowledge: a fresh clone sends none, and its client expects
    // the response to start with the packfile section instead. The `ready`
    // line says the packfile follows: without it, a client that negotiated
    // (wait-for-done) refuses any further section after the acks.
    const sections: Buffer[] = [];
    if (haves.length > 0 || shallowHeld.length > 0) {
      sections.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), pktDelim());
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      sections.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) sections.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) sections.push(pktLine(`unshallow ${oid}\n`));
      sections.push(pktDelim());
    }
    if (plan.pack !== null) {
      sections.push(pktLine('packfile\n'));
      sections.push(sidebandPack(plan.pack));
    }
    sections.push(pktFlush());
    return text(200, 'application/x-git-upload-pack-result', Buffer.concat(sections));
  }

  return json(400, { message: `unsupported command ${command}` });
}

function handleV0Fetch(forge: Forge, repo: Repo, body: Buffer): HandlerResult {
  const packets = parsePktOrBad(body);
  if (packets === null) return BAD_REQUEST();
  const lines = packetLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowHeld: string[] = [];
  let deepen: number | undefined;
  for (const line of lines) {
    const textLine = line.trim();
    if (textLine.startsWith('want ')) {
      const oid = textLine.slice(5).split(' ')[0];
      if (isObjectId(oid)) wants.push(oid);
    } else if (textLine.startsWith('have ')) {
      const oid = textLine.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (textLine.startsWith('shallow ')) {
      const oid = textLine.slice(8).trim();
      if (isObjectId(oid)) shallowHeld.push(oid);
    } else if (textLine.startsWith('deepen ')) {
      const n = Number(textLine.slice(7).trim());
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
  }
  const plan = fetchPackFor(forge, wants, haves, shallowHeld, deepen);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  if (plan.shallow.length > 0) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  if (plan.pack !== null) {
    parts.push(sidebandPack(plan.pack));
  }
  parts.push(pktFlush());
  return text(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): HandlerResult {
  // The body is: pkt-lines of ref commands, a flush, then the raw pack.
  // Only the pkt-line prefix is framed; the pack bytes after the flush are raw.
  const prefix = decodePktPrefix(body);
  if (prefix === null) return BAD_REQUEST();
  const { packets, consumed: packOffset } = prefix;
  const lines = packetLines(packets);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of lines) {
    const fields = line.trimEnd().split(' ');
    if (fields.length < 3) continue;
    const [oldOid, newOid, refWithCaps] = fields;
    const ref = refWithCaps.split('\0')[0];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = body.subarray(packOffset);
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasPack) {
    if (packBytes.length === 0) return BAD_REQUEST();
    if (!verifyPackChecksum(packBytes)) return BAD_REQUEST();
    let read;
    try {
      read = readPack(packBytes, { resolveBase: (oid) => fetchObjectByOid(forge, oid) });
    } catch {
      return BAD_REQUEST();
    }
    for (const object of read.objects.values()) {
      forge.objects.set(hashObject(object.type, object.data), object);
    }
  }
  const results: string[] = ['unpack ok'];
  for (const command of commands) {
    const applied = forge.applyRefUpdate(repo, command.oldOid, command.newOid, command.ref);
    results.push(applied.ok ? `ok ${command.ref}` : `ng ${command.ref} ${applied.reason}`);
  }
  // The report-status stream is itself pkt-lined inside band 1, and ends with
  // its own flush packet before the outer flush ends the sideband stream:
  // git's report reader dies on EOF without that inner flush.
  const report = pktLines([...results.map((line) => `${line}\n`), 'flush']);
  const reportPackets = pktLine(Buffer.concat([Buffer.from([1]), report]));
  const out = Buffer.concat([reportPackets, pktFlush()]);
  return text(200, 'application/x-git-receive-pack-result', out);
}
