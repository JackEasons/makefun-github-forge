// git.ts — git smart HTTP: info/refs advertisement (v0 and v2), ls-refs, fetch
// and receive-pack, following the client's protocol (v2 when advertised).

import type { Forge, Repo } from './store.ts';
import {
  decodePktLines,
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

function splitV2Commands(body: Buffer): { commands: Array<Array<{ key: string; value: string }>> } {
  const commands: Array<Array<{ key: string; value: string }>> = [];
  let current: Array<{ key: string; value: string }> = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      commands.push(current);
      current = [];
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    const eq = line.indexOf('=');
    if (eq >= 0) current.push({ key: line.slice(0, eq), value: line.slice(eq + 1).trimEnd() });
    else current.push({ key: line.trimEnd(), value: '' });
  }
  commands.push(current);
  return { commands };
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
  if (firstLine.trim() === 'version 2') {
    return handleV2(forge, repo, body);
  }
  return handleV0Fetch(forge, repo, body);
}

function handleV2(forge: Forge, repo: Repo, body: Buffer): HandlerResult {
  const { commands } = splitV2Commands(body);
  const args = commands[0] ?? [];
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
    const plan = forge.planFetch({ wants, haves, shallowHeld, depth: deepen });
    const sections: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      sections.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) sections.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) sections.push(pktLine(`unshallow ${oid}\n`));
      sections.push(pktDelim());
    }
    if (plan.objects.length > 0) {
      const pack = writePack(plan.objects);
      sections.push(pktLine('packfile\n'));
      sections.push(sidebandPack(pack));
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
  const plan = forge.planFetch({ wants, haves, shallowHeld, depth: deepen });
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  if (plan.shallow.length > 0) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return text(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): HandlerResult {
  // The body is: pkt-lines of ref commands, a flush, then the raw pack.
  const packets = parsePktOrBad(body);
  if (packets === null) return BAD_REQUEST();
  const lines = packetLines(packets);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packOffset = 0;
  {
    // Find where the pkt-line section ends (the first flush packet).
    let offset = 0;
    let foundFlush = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') { foundFlush = true; offset += 4; break; }
      if (packet.kind === 'data') {
        offset += 4 + packet.payload.length;
      } else if (packet.kind === 'delim') {
        offset += 4;
      } else {
        offset += 4;
      }
    }
    if (!foundFlush) return BAD_REQUEST();
    packOffset = offset;
  }
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
  const report = pktLines(results.map((line) => `${line}\n`));
  const reportPackets = pktLine(Buffer.concat([Buffer.from([1]), report]));
  const out = Buffer.concat([reportPackets, pktFlush()]);
  return text(200, 'application/x-git-receive-pack-result', out);
}
