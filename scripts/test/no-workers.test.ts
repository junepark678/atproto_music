import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const copies: string[] = [];

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

type AstNode = {
  type?: string;
  value?: unknown;
  name?: unknown;
  source?: AstNode;
  argument?: AstNode;
  callee?: AstNode;
  object?: AstNode;
  property?: AstNode;
  arguments?: AstNode[];
  [key: string]: unknown;
};

function moduleLiteral(node: AstNode | undefined): string | null {
  if (node?.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = node.quasis as Array<{ value?: { cooked?: unknown } }> | undefined;
    const value = quasis?.[0]?.value?.cooked;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function forbiddenModule(sourcePath: string, sourceText: string): string[] {
  const isTs = /\.(?:ts|tsx|mts|cts)$/.test(sourcePath);
  const source = parse(sourceText, {
    sourceType: 'unambiguous',
    plugins: [...(isTs ? ['typescript' as const] : []), 'jsx', 'decorators-legacy'],
  }) as unknown as AstNode;
  const found = new Set<string>();
  const check = (node: AstNode | undefined) => {
    const name = moduleLiteral(node);
    if (name?.startsWith('cloudflare:') || name?.startsWith('@cloudflare/')) found.add(name);
  };
  const visit = (node: AstNode) => {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      check(node.source);
    } else if (node.type === 'TSImportType') {
      check(node.argument);
    } else if (node.type === 'CallExpression' || node.type === 'ImportExpression') {
      const callee = node.callee;
      const method = callee?.type === 'Identifier' ? callee.name : undefined;
      const mocked =
        callee?.type === 'MemberExpression' &&
        callee.computed !== true &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'mock' &&
        callee.object?.type === 'Identifier' &&
        ['vi', 'jest'].includes(String(callee.object.name));
      if (node.type === 'ImportExpression') check(node.source as AstNode | undefined);
      else if (method === 'require' || mocked || callee?.type === 'Import') check(node.arguments?.[0]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value)
          if (child !== null && typeof child === 'object' && 'type' in child) visit(child as AstNode);
      } else if (value !== null && typeof value === 'object' && 'type' in value) visit(value as AstNode);
    }
  };
  visit(source);
  return [...found].sort();
}

function runsWrangler(file: string, text: string): boolean {
  if (/\.sh$/.test(file)) {
    return text
      .split('\n')
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .some(commandRunsWrangler);
  }
  if (/\.ts$/.test(file)) {
    let found = false;
    const source = parse(text, { sourceType: 'unambiguous', plugins: ['typescript'] }) as unknown as AstNode;
    const visit = (node: AstNode) => {
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const method = callee?.type === 'Identifier' ? callee.name : undefined;
        if (
          typeof method === 'string' &&
          ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'].includes(method)
        ) {
          const first = moduleLiteral(node.arguments?.[0]);
          const argv = node.arguments?.[1];
          const elements = argv?.type === 'ArrayExpression' ? (argv.elements as Array<AstNode | null>) : undefined;
          const firstArrayItem = elements !== undefined ? moduleLiteral(elements[0] ?? undefined) : null;
          if (first === 'wrangler' || firstArrayItem === 'wrangler') found = true;
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value)
            if (child !== null && typeof child === 'object' && 'type' in child) visit(child as AstNode);
        } else if (value !== null && typeof value === 'object' && 'type' in value) visit(value as AstNode);
      }
    };
    visit(source);
    return found;
  }
  if (/\.py$/.test(file)) {
    return /(?:subprocess\.(?:run|Popen|call|check_call|check_output)\s*\(\s*(?:\[\s*)?["']wrangler["']|os\.system\s*\(\s*["'][^"']*\bwrangler\b)/.test(
      text,
    );
  }
  return false;
}

function workflowRunsWrangler(text: string): boolean {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index] ?? '');
    if (!match) continue;
    const first = match[2]?.trim() ?? '';
    if (/^[|>][+-]?$/.test(first)) {
      const indent = match[1]?.length ?? 0;
      const block: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? '';
        if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
        block.push(line.trim());
      }
      if (block.some(commandRunsWrangler)) return true;
    } else if (commandRunsWrangler(first)) return true;
  }
  return false;
}

function commandRunsWrangler(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:(?:command|npx|npm\s+exec\s+--|pnpm\s+exec|yarn\s+dlx)\s+)*(?:wrangler|(?:\.\/)?node_modules\/\.bin\/wrangler)(?:\s|$)/.test(
    command.replace(/\s+#.*$/, ''),
  );
}

function noWorkersViolations(files: string[]): string[] {
  const problems: string[] = [];
  const packageFiles = files.filter((file) => file === 'package.json' || file.endsWith('/package.json'));
  for (const file of packageFiles) {
    const pkg = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg[field];
      if (deps === null || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps)) {
        if (name === 'wrangler' || name.startsWith('@cloudflare/')) problems.push(`${file}: declares ${name}`);
      }
    }
    const scripts = pkg.scripts;
    if (scripts !== null && typeof scripts === 'object') {
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command === 'string' && commandRunsWrangler(command)) {
          problems.push(`${file}: script ${name} runs wrangler`);
        }
      }
    }
  }

  for (const file of files) {
    const sourcePath = join(ROOT, file);
    if (!existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink()) continue;
    const text = readFileSync(sourcePath, 'utf8');
    if (/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file)) {
      for (const name of forbiddenModule(file, text)) problems.push(`${file}: imports ${name}`);
    }
    if (runsWrangler(file, text)) problems.push(`${file}: executes wrangler`);
    if (file.startsWith('.github/workflows/') && /\.ya?ml$/.test(file) && workflowRunsWrangler(text)) {
      problems.push(`${file}: workflow runs wrangler`);
    }
  }

  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, unknown>;
  };
  for (const name of Object.keys(lock.packages ?? {})) {
    if (name === 'node_modules/workerd' || name.startsWith('node_modules/@cloudflare/')) {
      problems.push(`package-lock.json: retains ${name}`);
    }
  }
  return problems.sort();
}

function copySource(): string {
  const copy = mkdtempSync(join(tmpdir(), 'atmusic-no-workers-'));
  copies.push(copy);
  for (const file of trackedFiles()) {
    if (file === 'scripts/test/no-workers.test.ts') continue;
    if (file === 'node_modules' || file.startsWith('node_modules/') || file === '.git' || file.startsWith('.git/')) {
      continue;
    }
    const source = join(ROOT, file);
    if (!existsSync(source)) continue;
    const target = join(copy, file);
    mkdirSync(dirname(target), { recursive: true });
    if (lstatSync(source).isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
    }
  }
  const init = run('git', ['init', '--quiet'], copy, 10_000);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  const add = run('git', ['add', '-A'], copy, 10_000);
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = run(
    'git',
    [
      '-c',
      'user.name=Node acceptance',
      '-c',
      'user.email=node-acceptance@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'acceptance snapshot',
    ],
    copy,
    10_000,
  );
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return copy;
}

function run(command: string, args: string[], cwd: string, timeout: number, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 512 * 1024 * 1024,
    env: {
      ...process.env,
      CI: 'true',
      NO_COLOR: '1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      ...extraEnv,
    },
  });
}

// The disposable no-workerd check creates and removes a full source copy;
// hosted runners can need longer than Vitest's default 10 s hook timeout.
afterEach(() => {
  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
}, 60_000);

describe('N7 Node-only runtime', () => {
  it('no tracked source imports cloudflare:* or @cloudflare/*, no package.json declares wrangler or @cloudflare/*, no workflow or script runs wrangler, and package-lock.json contains no workerd', () => {
    const files = trackedFiles();
    const problems = noWorkersViolations(files);
    expect(problems).toEqual([]);
  });

  it('worker/vitest.modules.config.ts has no cloudflare:* alias and no file under worker/test imports cloudflare:test or cloudflare:workers', () => {
    const config = readFileSync(join(ROOT, 'worker/vitest.modules.config.ts'), 'utf8');
    expect(config).not.toMatch(/cloudflare:(?:test|workers)/);
    const files = trackedFiles().filter(
      (file) => file.startsWith('worker/test/') && /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file),
    );
    const problems = files.flatMap((file) => {
      const source = join(ROOT, file);
      if (!existsSync(source) || lstatSync(source).isSymbolicLink()) return [];
      return forbiddenModule(file, readFileSync(source, 'utf8')).map((name) => `${file}: imports ${name}`);
    });
    expect(problems).toEqual([]);
  });

  it(
    'npm run check passes in a disposable copy with no workerd binary installed',
    () => {
      const copy = copySource();
      const install = run('npm', ['ci'], copy, 20 * 60_000);
      if (install.status !== 0) {
        throw new Error(`npm ci failed (${String(install.status)}):\n${install.stdout}\n${install.stderr}`);
      }
      expect(existsSync(join(copy, 'node_modules/workerd'))).toBe(false);
      expect(existsSync(join(copy, 'node_modules/.bin/workerd'))).toBe(false);

      const venv = join(copy, '.venv');
      const makeVenv = run('python3', ['-m', 'venv', venv], copy, 60_000);
      if (makeVenv.status !== 0) {
        throw new Error(`python3 -m venv failed (${String(makeVenv.status)}):\n${makeVenv.stdout}\n${makeVenv.stderr}`);
      }
      const installPython = run(
        join(venv, 'bin/python'),
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--quiet',
          '-r',
          join(copy, 'api/requirements-contracts.txt'),
        ],
        copy,
        5 * 60_000,
      );
      if (installPython.status !== 0) {
        throw new Error(
          `contract dependency install failed (${String(installPython.status)}):\n${installPython.stdout}\n${installPython.stderr}`,
        );
      }

      const check = run('npm', ['run', 'check'], copy, 25 * 60_000, {
        VIRTUAL_ENV: venv,
        PATH: `${join(venv, 'bin')}:${process.env.PATH ?? ''}`,
      });
      if (check.status !== 0) {
        throw new Error(`npm run check failed (${String(check.status)}):\n${check.stdout}\n${check.stderr}`);
      }
    },
    46 * 60_000,
  );
});
