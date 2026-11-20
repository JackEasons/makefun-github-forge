// graphql.ts — a small GraphQL parser and executor for the fixed document shapes
// the harness uses: viewer/repository/node/__type queries, issue and pull-request
// connections with cursor pagination, and the five mutations. It supports
// variables, aliases, inline fragments, named fragments and batched requests.

import type { Forge, Issue, PullRequest, Repo } from './store.ts';
import { VIEWER_LOGIN, decodeGlobalId, globalId } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; continue; }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind} ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value as string;
        const variableDefinitions = this.parseVariableDefinitions();
        operations.push({ kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.kind} ${JSON.stringify(token.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value as string;
        return { kind: 'spread', name };
      }
      if (next.kind === 'punct' && next.value === '{') {
        return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
      }
      throw new Error('invalid fragment spread');
    }
    if (token.kind !== 'name') throw new Error(`expected a field name, got ${token.kind}`);
    let name = this.next().value as string;
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return valueOf(arg.value, variables);
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type AnyObject = { __typename: string; [key: string]: unknown };

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function issueObject(repo: Repo, issue: Issue): AnyObject {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullObject(repo: Repo, pr: PullRequest): AnyObject {
  const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pr: pr,
    id: globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    state,
    merged: pr.merged,
    headRefName: pr.head,
    baseRefName: pr.base,
  };
}

function repoObject(repo: Repo): AnyObject {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function typeObject(name: string): AnyObject | null {
  const fields: Record<string, string[]> = {
    Issue: ISSUE_FIELDS,
    PullRequest: PULL_REQUEST_FIELDS,
    Repository: REPOSITORY_FIELDS,
  };
  if (name === 'SearchType') {
    return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((v) => ({ name: v })) };
  }
  if (fields[name]) {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: fields[name].map((f) => ({ name: f })), enumValues: null };
  }
  return null;
}

function findRepoById(forge: Forge, id: unknown): Repo | undefined {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return undefined;
  for (const repo of forge.repos.values()) if (repo.id === numeric) return repo;
  return undefined;
}

function resolveField(ctx: ExecContext, parent: AnyObject, field: FieldNode): unknown {
  const typeName = parent.__typename;
  const name = field.name;
  const variables = ctx.variables;

  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
    if (name === 'repository') {
      const owner = argValue(field, 'owner', variables);
      const repoName = argValue(field, 'name', variables);
      const repo = typeof owner === 'string' && typeof repoName === 'string' ? ctx.forge.getRepo(owner, repoName) : undefined;
      return repo ? repoObject(repo) : null;
    }
    if (name === 'node') {
      const id = argValue(field, 'id', variables);
      const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(ctx.forge, decoded.parts[0]);
        return repo ? repoObject(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoById(ctx.forge, decoded.parts[0]);
        const issue = repo ? ctx.forge.getIssue(repo, Number(decoded.parts[1])) : undefined;
        return issue && repo ? issueObject(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = findRepoById(ctx.forge, decoded.parts[0]);
        const pr = repo ? ctx.forge.getPull(repo, Number(decoded.parts[1])) : undefined;
        return pr && repo ? pullObject(repo, pr) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = argValue(field, 'name', variables);
      return typeof typeNameArg === 'string' ? typeObject(typeNameArg) : null;
    }
    if (name === '__schema') {
      return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
    return null;
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(ctx, field);
    if (name === 'closeIssue') return mutateCloseIssue(ctx, field);
    if (name === 'createPullRequest') return mutateCreatePullRequest(ctx, field);
    if (name === 'mergePullRequest') return mutateMergePullRequest(ctx, field);
    if (name === 'addComment') return mutateAddComment(ctx, field);
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
    return null;
  }

  if (typeName === 'User') {
    if (name === 'login') return (parent as unknown as { login: string }).login;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "User".` });
    return null;
  }

  if (typeName === 'Ref') {
    if (name === 'name') return (parent as unknown as { name: string }).name;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Ref".` });
    return null;
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue') {
      const number = argValue(field, 'number', variables);
      const issue = typeof number === 'number' ? ctx.forge.getIssue(repo, number) : undefined;
      return issue ? issueObject(repo, issue) : null;
    }
    if (name === 'issues') {
      const first = argValue(field, 'first', variables);
      const states = argValue(field, 'states', variables);
      const orderBy = argValue(field, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
      const after = argValue(field, 'after', variables);
      let issues = [...repo.issues];
      if (Array.isArray(states) && states.length > 0) {
        issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      if (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'DESC') issues.sort((a, b) => b.number - a.number);
      else issues.sort((a, b) => a.number - b.number);
      const start = decodeCursor(after) + 1;
      const count = typeof first === 'number' ? first : issues.length;
      const slice = issues.slice(start, start + count);
      return {
        __typename: 'IssueConnection',
        nodes: slice.map((issue) => issueObject(repo, issue)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: start + count < issues.length,
          endCursor: slice.length > 0 ? encodeCursor(start + slice.length - 1) : null,
        },
      };
    }
    if (name === 'pullRequests') {
      const first = argValue(field, 'first', variables);
      const count = typeof first === 'number' ? first : repo.pulls.length;
      return {
        __typename: 'PullRequestConnection',
        nodes: repo.pulls.slice(0, count).map((pr) => pullObject(repo, pr)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: count < repo.pulls.length, endCursor: null },
      };
    }
    if (name === 'pullRequest') {
      const number = argValue(field, 'number', variables);
      const pr = typeof number === 'number' ? ctx.forge.getPull(repo, number) : undefined;
      return pr ? pullObject(repo, pr) : null;
    }
    if (['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled'].includes(name)) {
      return parent[name];
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
    return null;
  }

  if (typeName === 'Issue') {
    if (ISSUE_FIELDS.includes(name)) return parent[name];
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
    return null;
  }

  if (typeName === 'PullRequest') {
    if (name === 'mergeable') {
      const repo = parent.__repo as Repo;
      const pr = parent.__pr as PullRequest;
      return ctx.forge.pullMergeable(repo, pr);
    }
    if (name === 'files') {
      const repo = parent.__repo as Repo;
      const pr = parent.__pr as PullRequest;
      const first = argValue(field, 'first', variables);
      const files = ctx.forge.pullFiles(repo, pr);
      const count = typeof first === 'number' ? first : files.length;
      return {
        __typename: 'PullRequestFileConnection',
        nodes: files.slice(0, count).map((file) => ({ __typename: 'PullRequestFile', path: file.path })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: count < files.length, endCursor: null },
      };
    }
    if (PULL_REQUEST_FIELDS.includes(name)) return parent[name];
    ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
    return null;
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (name === 'nodes') return parent.nodes;
    if (name === 'pageInfo') return parent.pageInfo;
    if (name === 'edges') {
      const nodes = (parent.nodes as AnyObject[]) ?? [];
      return nodes.map((node) => ({ __typename: 'Edge', node, cursor: encodeCursor(0) }));
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }

  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return (parent as unknown as { hasNextPage: boolean }).hasNextPage;
    if (name === 'endCursor') return (parent as unknown as { endCursor: string | null }).endCursor;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "PageInfo".` });
    return null;
  }

  if (typeName === '__Type') {
    if (name === 'name') return (parent as unknown as { name: string }).name;
    if (name === 'kind') return (parent as unknown as { kind: string }).kind;
    if (name === 'fields') return (parent as unknown as { fields: unknown }).fields;
    if (name === 'enumValues') return (parent as unknown as { enumValues: unknown }).enumValues;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
    return null;
  }

  if (typeName === '__Schema') {
    if (name === 'queryType') return (parent as unknown as { queryType: unknown }).queryType;
    if (name === 'mutationType') return (parent as unknown as { mutationType: unknown }).mutationType;
    if (name === 'types') return [];
    if (name === 'directives') return [];
    ctx.errors.push({ message: `Cannot query field "${name}" on type "__Schema".` });
    return null;
  }

  if (typeName === 'PullRequestFile') {
    if (name === 'path') return (parent as unknown as { path: string }).path;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFile".` });
    return null;
  }

  if (typeName === 'Edge') {
    if (name === 'node') return (parent as unknown as { node: unknown }).node;
    if (name === 'cursor') return (parent as unknown as { cursor: string }).cursor;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Edge".` });
    return null;
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function inputObject(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const input = argValue(field, 'input', variables);
  return (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
}

function mutateCreateIssue(ctx: ExecContext, field: FieldNode): AnyObject {
  const input = inputObject(field, ctx.variables);
  const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
  const repo = decoded?.kind === 'Repository' ? findRepoById(ctx.forge, decoded.parts[0]) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'repository not found' });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  const created = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
  if ('error' in created) {
    ctx.errors.push({ message: created.error });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  return { __typename: 'CreateIssuePayload', issue: issueObject(repo, created) };
}

function mutateCloseIssue(ctx: ExecContext, field: FieldNode): AnyObject {
  const input = inputObject(field, ctx.variables);
  const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
  const repo = decoded?.kind === 'Issue' ? findRepoById(ctx.forge, decoded.parts[0]) : undefined;
  const issue = repo ? ctx.forge.getIssue(repo, Number(decoded!.parts[1])) : undefined;
  if (!issue || !repo) {
    ctx.errors.push({ message: 'issue not found' });
    return { __typename: 'CloseIssuePayload', issue: null };
  }
  issue.state = 'closed';
  issue.updatedAt = new Date().toISOString();
  return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
}

function mutateCreatePullRequest(ctx: ExecContext, field: FieldNode): AnyObject {
  const input = inputObject(field, ctx.variables);
  const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
  const repo = decoded?.kind === 'Repository' ? findRepoById(ctx.forge, decoded.parts[0]) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'repository not found' });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  }
  const created = ctx.forge.createPull(repo, {
    title: String(input.title ?? ''),
    body: '',
    head: String(input.headRefName ?? ''),
    base: String(input.baseRefName ?? ''),
  });
  if ('error' in created) {
    ctx.errors.push({ message: created.error });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  }
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created) };
}

function mutateMergePullRequest(ctx: ExecContext, field: FieldNode): AnyObject {
  const input = inputObject(field, ctx.variables);
  const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
  const repo = decoded?.kind === 'PullRequest' ? findRepoById(ctx.forge, decoded.parts[0]) : undefined;
  const pr = repo ? ctx.forge.getPull(repo, Number(decoded!.parts[1])) : undefined;
  if (!pr || !repo) {
    ctx.errors.push({ message: 'pull request not found' });
    return { __typename: 'MergePullRequestPayload', pullRequest: null };
  }
  const merged = ctx.forge.mergePull(repo, pr);
  if ('status' in merged) {
    ctx.errors.push({ message: merged.message });
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pr) };
  }
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pr) };
}

function mutateAddComment(ctx: ExecContext, field: FieldNode): AnyObject {
  const input = inputObject(field, ctx.variables);
  const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
  const repo = decoded?.kind === 'Issue' ? findRepoById(ctx.forge, decoded.parts[0]) : undefined;
  const issue = repo ? ctx.forge.getIssue(repo, Number(decoded!.parts[1])) : undefined;
  if (!issue || !repo) {
    ctx.errors.push({ message: 'subject not found' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const comment = ctx.forge.addComment(repo, issue.number, String(input.body ?? ''));
  if (!comment) {
    ctx.errors.push({ message: 'subject not found' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const node: AnyObject = {
    __typename: 'IssueComment',
    id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
  };
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(0) },
  };
}

// ---------------------------------------------------------------------------
// selection execution
// ---------------------------------------------------------------------------

function executeSelectionSet(
  ctx: ExecContext,
  parent: AnyObject,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        const nested = executeSelectionSet(ctx, parent, fragment.selectionSet);
        Object.assign(out, nested);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      const nested = executeSelectionSet(ctx, parent, selection.selectionSet);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, parent, selection);
    if (selection.selectionSet === null || value === null || value === undefined) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? executeSelectionSet(ctx, item as AnyObject, selection.selectionSet!)
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[key] = executeSelectionSet(ctx, value as AnyObject, selection.selectionSet);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(
  forge: Forge,
  document: DocumentNode,
  operation: OperationNode,
  variables: Record<string, unknown>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObject = { __typename: rootType };
  const data = executeSelectionSet(ctx, root, operation.selectionSet);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export function executeGraphQL(
  forge: Forge,
  body: unknown,
): { status: number; value: unknown } {
  const requests = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const request of requests) {
    const req = (request !== null && typeof request === 'object' ? request : {}) as GraphQLRequestBody;
    if (typeof req.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    let document: DocumentNode;
    try {
      document = new Parser(lex(req.query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: (err as Error).message }] });
      continue;
    }
    const variables = (req.variables !== null && typeof req.variables === 'object' && !Array.isArray(req.variables)
      ? req.variables
      : {}) as Record<string, unknown>;
    const operation =
      typeof req.operationName === 'string'
        ? document.operations.find((op) => op.name === req.operationName)
        : document.operations[0];
    if (!operation) {
      results.push({ data: null, errors: [{ message: `unknown operation ${String(req.operationName)}` }] });
      continue;
    }
    // Apply variable defaults for missing variables.
    for (const def of operation.variableDefinitions) {
      if (!(def.name in variables) && def.defaultValue !== null) {
        variables[def.name] = valueOf(def.defaultValue, variables);
      }
    }
    results.push(executeOperation(forge, document, operation, variables));
  }
  return { status: 200, value: Array.isArray(body) ? results : results[0] };
}
