// GraphQL: a schema-first, resolver-table executor.
//
// The schema is data: every type is a table of fields, and every field is a row naming its type
// and a resolver function. One generic executor walks the document's selections and looks each
// field up in the table — there is no per-type dispatch code and no hand-rolled recursive
// executor. A small tokenizer/parser turns the document text into a selection tree first; all
// semantics (introspection, fragments, variables, batching, cursors, mutations) live in the
// tables and the generic executor.
//
// Global ids are base64("<Type>:<databaseId>"); cursors are base64("cursor:<number>").

import { b64decode, b64encode } from './util.ts';
import { VIEWER } from './scenario.ts';
import { NotFoundError, Store, ValidationError, type IssueRecord, type PullRecord, type Repo } from './store.ts';

/* ------------------------------------------------------------------ */
/* Document parsing (tokenizer + selection tree)                       */
/* ------------------------------------------------------------------ */

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

interface SelectionNode {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name?: string;
  alias?: string;
  args?: Record<string, ValueNode>;
  directives?: DirectiveNode[];
  selections?: SelectionNode[];
  typeCondition?: string;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(\.\d+)?/.exec(source.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  readonly #tokens: string[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  peek(): string | undefined {
    return this.#tokens[this.#pos];
  }

  next(): string {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.#pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`Expected ${JSON.stringify(token)} in GraphQL document, got ${JSON.stringify(got)}`);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: SelectionNode[] }>();
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token === 'fragment') {
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selections = this.parseSelections();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      if (token === '{') {
        const selections = this.parseSelectionsAfterBrace();
        operations.push({ kind: 'query', variableDefinitions: [], selections });
        continue;
      }
      if (token === 'query' || token === 'mutation') {
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        const variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }> = [];
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            if (this.peek() === '[') {
              // Skip a list type wrapper like [String!]!
              let depth = 0;
              while (this.peek() !== undefined) {
                const t = this.next();
                if (t === '[') depth += 1;
                else if (t === ']') {
                  depth -= 1;
                  if (depth === 0) break;
                }
              }
            } else {
              this.next(); // the named type, e.g. String
            }
            if (this.peek() === '!') this.next();
            let defaultValue: ValueNode | undefined;
            if (this.peek() === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            variableDefinitions.push({ name: varName, defaultValue });
          }
          this.expect(')');
        }
        const selections = this.parseSelections();
        operations.push({ kind: token, name, variableDefinitions, selections });
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  parseSelections(): SelectionNode[] {
    this.expect('{');
    return this.parseSelectionsAfterBrace();
  }

  parseSelectionsAfterBrace(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('Unterminated selection set in GraphQL document');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      const name = this.next();
      if (name === 'on') {
        const typeCondition = this.next();
        const directives = this.parseDirectives();
        const selections = this.parseSelections();
        return { kind: 'inlineFragment', typeCondition, directives, selections };
      }
      const directives = this.parseDirectives();
      return { kind: 'fragmentSpread', name, directives };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selections = this.peek() === '{' ? this.parseSelections() : undefined;
    return { kind: 'field', name, alias, args, directives, selections };
  }

  parseArguments(): Record<string, ValueNode> | undefined {
    if (this.peek() !== '(') return undefined;
    this.next();
    const args: Record<string, ValueNode> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseDirectives(): DirectiveNode[] | undefined {
    const directives: DirectiveNode[] = [];
    while (this.peek() === '@') {
      this.next();
      const name = this.next();
      const args = this.parseArguments() ?? {};
      directives.push({ name, args });
    }
    return directives.length ? directives : undefined;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

/* ------------------------------------------------------------------ */
/* Schema tables                                                       */
/* ------------------------------------------------------------------ */

interface FieldDef {
  type: string;
  args?: readonly string[];
  resolve: (source: any, args: Record<string, unknown>, ctx: GraphContext) => unknown;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  values?: readonly string[];
  inputFields?: readonly string[];
}

interface GraphContext {
  store: Store;
}

function globalId(type: string, id: number | string): string {
  return b64encode(Buffer.from(`${type}:${id}`, 'utf8'));
}

function decodeGlobalId(id: string): { type: string; id: string } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), id: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return b64encode(Buffer.from(`cursor:${number}`, 'utf8'));
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function userObject(login: string): Record<string, unknown> {
  return { __typename: 'User', login, id: 1000, name: login === VIEWER.login ? VIEWER.name : login, email: `${login}@example.invalid` };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pull: PullRecord): Record<string, unknown> {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  return [...store.repos.values()].find((repo) => repo.record.id === id);
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: IssueRecord } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function findPullById(store: Store, id: number): { repo: Repo; pull: PullRecord } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return undefined;
}

function paginateIssues(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const wanted = new Set(states);
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  if ((orderBy.field ?? 'CREATED_AT') === 'CREATED_AT') {
    issues.sort((a, b) => direction * (a.createdAt - b.createdAt || a.number - b.number));
  } else {
    issues.sort((a, b) => direction * (a.updatedAt - b.updatedAt || a.number - b.number));
  }
  const afterNumber = numberFromCursor(args.after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor: page.length ? cursorFor(page[page.length - 1]?.number as number) : null,
    },
    totalCount: issues.length,
  };
}

function paginatePulls(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: pulls.length > page.length,
      endCursor: page.length ? cursorFor(page[page.length - 1]?.number as number) : null,
    },
    totalCount: pulls.length,
  };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: {
        type: 'User',
        resolve: () => userObject(VIEWER.login),
      },
      repository: {
        type: 'Repository',
        args: ['owner', 'name'],
        resolve: (_source, args, ctx) => {
          const repo = ctx.store.repos.get(`${args.owner as string}/${args.name as string}`);
          return repo ? repoObject(repo) : null;
        },
      },
      node: {
        type: 'Node',
        args: ['id'],
        resolve: (_source, args, ctx) => {
          const decoded = decodeGlobalId(args.id as string);
          if (!decoded) return null;
          if (decoded.type === 'Repository') {
            const repo = findRepoById(ctx.store, Number.parseInt(decoded.id, 10));
            return repo ? repoObject(repo) : null;
          }
          if (decoded.type === 'Issue') {
            const found = findIssueById(ctx.store, Number.parseInt(decoded.id, 10));
            return found ? issueObject(found.repo, found.issue) : null;
          }
          if (decoded.type === 'PullRequest') {
            const found = findPullById(ctx.store, Number.parseInt(decoded.id, 10));
            return found ? pullObject(found.repo, found.pull) : null;
          }
          return null;
        },
      },
      __type: {
        type: '__Type',
        args: ['name'],
        resolve: (_source, args) => introspectType(args.name as string),
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({ __typename: '__Schema' }),
      },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        args: ['input'],
        resolve: (_source, args, ctx) => {
          const input = args.input as { repositoryId: string; title: string; body?: string };
          const decoded = decodeGlobalId(input.repositoryId);
          if (!decoded || decoded.type !== 'Repository') throw new ValidationError('repositoryId does not name a repository');
          const repo = findRepoById(ctx.store, Number.parseInt(decoded.id, 10));
          if (!repo) throw new NotFoundError('Repository not found');
          const issue = ctx.store.createIssue(repo, input.title, input.body ?? '', [], VIEWER.login);
          return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        args: ['input'],
        resolve: (_source, args, ctx) => {
          const input = args.input as { issueId: string };
          const decoded = decodeGlobalId(input.issueId);
          if (!decoded || decoded.type !== 'Issue') throw new ValidationError('issueId does not name an issue');
          const found = findIssueById(ctx.store, Number.parseInt(decoded.id, 10));
          if (!found) throw new NotFoundError('Issue not found');
          const issue = ctx.store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
          return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, issue) };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        args: ['input'],
        resolve: (_source, args, ctx) => {
          const input = args.input as { repositoryId: string; baseRefName: string; headRefName: string; title: string; body?: string };
          const decoded = decodeGlobalId(input.repositoryId);
          if (!decoded || decoded.type !== 'Repository') throw new ValidationError('repositoryId does not name a repository');
          const repo = findRepoById(ctx.store, Number.parseInt(decoded.id, 10));
          if (!repo) throw new NotFoundError('Repository not found');
          const pull = ctx.store.createPull(repo, input.title, input.body ?? '', input.headRefName, input.baseRefName, VIEWER.login);
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        args: ['input'],
        resolve: (_source, args, ctx) => {
          const input = args.input as { pullRequestId: string; mergeMethod?: string };
          const decoded = decodeGlobalId(input.pullRequestId);
          if (!decoded || decoded.type !== 'PullRequest') throw new ValidationError('pullRequestId does not name a pull request');
          const found = findPullById(ctx.store, Number.parseInt(decoded.id, 10));
          if (!found) throw new NotFoundError('Pull request not found');
          const { pull } = ctx.store.mergePull(found.repo, found.pull.number, input.mergeMethod ?? 'SQUASH');
          return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, pull) };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        args: ['input'],
        resolve: (_source, args, ctx) => {
          const input = args.input as { subjectId: string; body: string };
          const decoded = decodeGlobalId(input.subjectId);
          if (!decoded || decoded.type !== 'Issue') throw new ValidationError('subjectId does not name an issue');
          const found = findIssueById(ctx.store, Number.parseInt(decoded.id, 10));
          if (!found) throw new NotFoundError('Issue not found');
          const comment = ctx.store.createComment(found.repo, found.issue.number, input.body, VIEWER.login);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: {
              __typename: 'IssueCommentEdge',
              node: { __typename: 'IssueComment', id: globalId('IssueComment', comment.id), databaseId: comment.id, body: comment.body },
            },
          };
        },
      },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (source) => globalId('Repository', (source.__repo as Repo).record.id) },
      databaseId: { type: 'Int', resolve: (source) => (source.__repo as Repo).record.id },
      name: { type: 'String', resolve: (source) => (source.__repo as Repo).record.name },
      nameWithOwner: { type: 'String', resolve: (source) => (source.__repo as Repo).record.fullName },
      owner: { type: 'User', resolve: (source) => userObject((source.__repo as Repo).record.owner) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (source) => ({ __typename: 'Ref', name: (source.__repo as Repo).record.defaultBranch }),
      },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      issue: {
        type: 'Issue',
        args: ['number'],
        resolve: (source, args) => {
          const repo = source.__repo as Repo;
          const issue = repo.issues.get(args.number as number);
          return issue ? issueObject(repo, issue) : null;
        },
      },
      issues: { type: 'IssueConnection', args: ['first', 'states', 'orderBy', 'after'], resolve: (source, args) => paginateIssues(source.__repo as Repo, args) },
      pullRequests: { type: 'PullRequestConnection', args: ['first'], resolve: (source, args) => paginatePulls(source.__repo as Repo, args) },
      pullRequest: {
        type: 'PullRequest',
        args: ['number'],
        resolve: (source, args) => {
          const repo = source.__repo as Repo;
          const pull = repo.pulls.get(args.number as number);
          return pull ? pullObject(repo, pull) : null;
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: { type: 'String', resolve: (source) => (source as { login: string }).login },
      id: { type: 'ID', resolve: (source) => globalId('User', (source as { login: string }).login) },
      databaseId: { type: 'Int', resolve: () => 1000 },
      name: { type: 'String', resolve: (source) => (source as { name?: string }).name ?? (source as { login: string }).login },
      email: { type: 'String', resolve: (source) => (source as { email?: string }).email ?? '' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (source) => globalId('Issue', (source.__issue as IssueRecord).id) },
      databaseId: { type: 'Int', resolve: (source) => (source.__issue as IssueRecord).id },
      number: { type: 'Int', resolve: (source) => (source.__issue as IssueRecord).number },
      title: { type: 'String', resolve: (source) => (source.__issue as IssueRecord).title },
      body: { type: 'String', resolve: (source) => (source.__issue as IssueRecord).body },
      state: { type: 'IssueState', resolve: (source) => ((source.__issue as IssueRecord).state === 'open' ? 'OPEN' : 'CLOSED') },
      author: { type: 'User', resolve: (source) => userObject((source.__issue as IssueRecord).userLogin) },
      url: {
        type: 'String',
        resolve: (source) => `https://github.com/${(source.__repo as Repo).record.fullName}/issues/${(source.__issue as IssueRecord).number}`,
      },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (source) => globalId('PullRequest', (source.__pull as PullRecord).id) },
      databaseId: { type: 'Int', resolve: (source) => (source.__pull as PullRecord).id },
      number: { type: 'Int', resolve: (source) => (source.__pull as PullRecord).number },
      title: { type: 'String', resolve: (source) => (source.__pull as PullRecord).title },
      body: { type: 'String', resolve: (source) => (source.__pull as PullRecord).body },
      state: {
        type: 'PullRequestState',
        resolve: (source) => {
          const pull = source.__pull as PullRecord;
          if (pull.merged) return 'MERGED';
          return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        },
      },
      merged: { type: 'Boolean', resolve: (source) => (source.__pull as PullRecord).merged },
      headRefName: { type: 'String', resolve: (source) => (source.__pull as PullRecord).headRef },
      baseRefName: { type: 'String', resolve: (source) => (source.__pull as PullRecord).baseRef },
      mergeable: {
        type: 'MergeableState',
        resolve: (source, _args, ctx) => ctx.store.mergeable(source.__repo as Repo, source.__pull as PullRecord),
      },
      files: {
        type: 'PullRequestFileConnection',
        args: ['first'],
        resolve: (source, args, ctx) => {
          const repo = source.__repo as Repo;
          const pull = source.__pull as PullRecord;
          const files = ctx.store.pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : files.length;
          const page = files.slice(0, first);
          return {
            __typename: 'PullRequestFileConnection',
            nodes: page.map((file) => ({ __typename: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > page.length, endCursor: null },
            totalCount: files.length,
          };
        },
      },
      author: { type: 'User', resolve: (source) => userObject((source.__pull as PullRecord).userLogin) },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (source) => (source as { name: string }).name },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]', resolve: (source) => (source as { nodes: unknown[] }).nodes },
      totalCount: { type: 'Int', resolve: (source) => (source as { totalCount: number }).totalCount },
      pageInfo: { type: 'PageInfo', resolve: (source) => (source as { pageInfo: unknown }).pageInfo },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]', resolve: (source) => (source as { nodes: unknown[] }).nodes },
      totalCount: { type: 'Int', resolve: (source) => (source as { totalCount: number }).totalCount },
      pageInfo: { type: 'PageInfo', resolve: (source) => (source as { pageInfo: unknown }).pageInfo },
    },
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestFile]', resolve: (source) => (source as { nodes: unknown[] }).nodes },
      totalCount: { type: 'Int', resolve: (source) => (source as { totalCount: number }).totalCount },
      pageInfo: { type: 'PageInfo', resolve: (source) => (source as { pageInfo: unknown }).pageInfo },
    },
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: (source) => (source as { path: string }).path },
      additions: { type: 'Int', resolve: (source) => (source as { additions: number }).additions },
      deletions: { type: 'Int', resolve: (source) => (source as { deletions: number }).deletions },
      changeType: { type: 'String', resolve: (source) => (source as { changeType: string }).changeType },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (source) => (source as { hasNextPage: boolean }).hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: () => false },
      endCursor: { type: 'String', resolve: (source) => (source as { endCursor: string | null }).endCursor ?? null },
      startCursor: { type: 'String', resolve: () => null },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (source) => (source as { id: string }).id },
      databaseId: { type: 'Int', resolve: (source) => (source as { databaseId: number }).databaseId },
      body: { type: 'String', resolve: (source) => (source as { body: string }).body },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment', resolve: (source) => (source as { node: unknown }).node },
      cursor: { type: 'String', resolve: () => null },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (source) => (source as { issue: unknown }).issue },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (source) => (source as { issue: unknown }).issue },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (source) => (source as { pullRequest: unknown }).pullRequest },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (source) => (source as { pullRequest: unknown }).pullRequest },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (source) => (source as { commentEdge: unknown }).commentEdge },
    },
  },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: { type: '__Type', resolve: () => introspectType('Query') },
      mutationType: { type: '__Type', resolve: () => introspectType('Mutation') },
      types: {
        type: '[__Type]',
        resolve: () => Object.keys(SCHEMA).filter((name) => !name.startsWith('__')).map((name) => introspectType(name)),
      },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (source) => (source as { name: string }).name },
      kind: { type: 'String', resolve: (source) => (source as { kind: string }).kind },
      fields: {
        type: '[__Field]',
        args: ['includeDeprecated'],
        resolve: (source) => {
          const def = SCHEMA[(source as { name: string }).name];
          if (!def?.fields) return null;
          return Object.keys(def.fields).map((name) => ({ __typename: '__Field', name, type: { __typename: '__Type', name: def.fields?.[name]?.type ?? 'String', kind: 'SCALAR' } }));
        },
      },
      enumValues: {
        type: '[__EnumValue]',
        args: ['includeDeprecated'],
        resolve: (source) => {
          const def = SCHEMA[(source as { name: string }).name];
          if (!def?.values) return null;
          return def.values.map((name) => ({ __typename: '__EnumValue', name }));
        },
      },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (source) => (source as { name: string }).name },
      type: { type: '__Type', resolve: (source) => (source as { type: unknown }).type },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (source) => (source as { name: string }).name },
    },
  },
};

function introspectType(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (!def) return null;
  return { __typename: '__Type', name, kind: def.kind };
}

/** The Node interface resolves to the concrete type carried by the resolved value. */
function concreteTypeName(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && '__typename' in value) {
    return (value as { __typename: string }).__typename;
  }
  return null;
}

function baseTypeName(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

function isListType(type: string): boolean {
  return type.startsWith('[');
}

/* ------------------------------------------------------------------ */
/* The generic executor                                                */
/* ------------------------------------------------------------------ */

interface ExecutionError {
  message: string;
}

function coerceValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => coerceValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = coerceValue(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function directiveSkips(directives: DirectiveNode[] | undefined, variables: Record<string, unknown>): boolean {
  if (!directives) return false;
  for (const directive of directives) {
    if (directive.name === 'skip' || directive.name === 'include') {
      const ifValue = coerceValue(directive.args['if'] as ValueNode, variables);
      const flag = ifValue === true;
      if (directive.name === 'skip' && flag) return true;
      if (directive.name === 'include' && !flag) return true;
    }
  }
  return false;
}

class Executor {
  readonly #ctx: GraphContext;
  readonly #document: DocumentNode;
  readonly #variables: Record<string, unknown>;
  readonly #errors: ExecutionError[] = [];

  constructor(ctx: GraphContext, document: DocumentNode, variables: Record<string, unknown>) {
    this.#ctx = ctx;
    this.#document = document;
    this.#variables = variables;
  }

  get errors(): ExecutionError[] {
    return this.#errors;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> | null {
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const rootSource = { __typename: rootType };
    const result = this.executeSelections(rootType, rootSource, operation.selections);
    return result as Record<string, unknown> | null;
  }

  /** Execute a selection set against a source value, looking every field up in the schema table. */
  executeSelections(typeName: string, source: unknown, selections: SelectionNode[]): Record<string, unknown> | null {
    if (source === null || source === undefined) return null;
    const typeDef = SCHEMA[typeName];
    if (!typeDef) {
      this.#errors.push({ message: `Unknown type "${typeName}"` });
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (directiveSkips(selection.directives, this.#variables)) continue;
      if (selection.kind === 'fragmentSpread') {
        const fragment = this.#document.fragments.get(selection.name as string);
        if (!fragment) {
          this.#errors.push({ message: `Unknown fragment "${selection.name}"` });
          continue;
        }
        if (fragment.typeCondition !== typeName && fragment.typeCondition !== 'Node') continue;
        const fragmentResult = this.executeSelections(typeName, source, fragment.selections);
        if (fragmentResult) Object.assign(out, fragmentResult);
        continue;
      }
      if (selection.kind === 'inlineFragment') {
        const condition = selection.typeCondition;
        if (condition && condition !== typeName && condition !== 'Node') continue;
        const fragmentResult = this.executeSelections(typeName, source, selection.selections ?? []);
        if (fragmentResult) Object.assign(out, fragmentResult);
        continue;
      }
      const fieldName = selection.name as string;
      if (fieldName === '__typename') {
        out[selection.alias ?? fieldName] = typeName;
        continue;
      }
      const fieldDef = typeDef.fields?.[fieldName];
      if (!fieldDef) {
        this.#errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
        continue;
      }
      const args: Record<string, unknown> = {};
      if (selection.args) {
        for (const [name, valueNode] of Object.entries(selection.args)) {
          args[name] = coerceValue(valueNode, this.#variables);
        }
      }
      let value: unknown;
      try {
        value = fieldDef.resolve(source, args, this.#ctx);
      } catch (err) {
        this.#errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[selection.alias ?? fieldName] = null;
        continue;
      }
      out[selection.alias ?? fieldName] = this.completeValue(fieldDef.type, value, selection.selections);
    }
    return out;
  }

  private completeValue(type: string, value: unknown, selections: SelectionNode[] | undefined): unknown {
    if (value === null || value === undefined) return null;
    const base = baseTypeName(type);
    if (isListType(type)) {
      if (!Array.isArray(value)) return null;
      return value.map((item) => this.completeValue(base, item, selections));
    }
    // The Node interface resolves through the concrete type carried by the value.
    if (base === 'Node') {
      const concrete = concreteTypeName(value);
      if (!concrete || !selections || selections.length === 0) return value;
      return this.executeSelections(concrete, value, selections);
    }
    const typeDef = SCHEMA[base];
    if (!typeDef || typeDef.kind !== 'OBJECT') return value;
    if (!selections || selections.length === 0) return value;
    return this.executeSelections(base, value, selections);
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const ctx: GraphContext = { store };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const operationName = (body as Record<string, unknown>).operationName as string | undefined;
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'Request body must include a query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName
    ? document.operations.find((op) => op.name === operationName)
    : document.operations[0];
  if (!operation) {
    return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (mergedVariables[def.name] === undefined && def.defaultValue !== undefined) {
      mergedVariables[def.name] = coerceValue(def.defaultValue, variables);
    }
  }
  const executor = new Executor(ctx, document, mergedVariables);
  const data = executor.executeOperation(operation);
  if (executor.errors.length > 0) {
    return { data: null, errors: executor.errors };
  }
  return { data };
}

/** Handle POST /api/graphql (single operation or a batch array). */
export function handleGraphQL(store: Store, authorization: string | undefined, rawBody: Buffer): GraphQLResult {
  if (!authorization || !/^Bearer\s+\S+$/.test(authorization)) {
    return { status: 401, body: { message: 'Requires authentication' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body must be valid JSON.' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((item) => executeOne(store, item)) };
  }
  return { status: 200, body: executeOne(store, parsed) };
}
