#!/usr/bin/env node
// Planejamento do CI: descobre os workspaces do monorepo, vê quais mudaram
// (mais os dependentes deles) e gera a matrix de jobs do workflow ci.yml.
//
// Só usa módulos nativos do Node (24+: fs.globSync e path.matchesGlob). Uso local:
//   node .github/scripts/ci-plan.mjs --all
//   node .github/scripts/ci-plan.mjs --base origin/main --head HEAD --merge-base
//   node .github/scripts/ci-plan.mjs --files lista.txt     (um caminho por linha; "-" = stdin)
// Sem argumentos, lê o evento do GitHub Actions (GITHUB_EVENT_NAME/GITHUB_EVENT_PATH).
//
// Saída: a matrix em JSON no stdout e um resumo no stderr. No Actions também
// escreve `matrix` e `empty` em $GITHUB_OUTPUT e o resumo em $GITHUB_STEP_SUMMARY.

import { execFileSync } from 'node:child_process';
import { appendFileSync, globSync, readFileSync } from 'node:fs';
import { matchesGlob, posix } from 'node:path';
import { parseArgs } from 'node:util';

// Scripts npm que viram job, nesta ordem. Só entram os que o workspace define.
// O `build` roda como está no package.json (é o mesmo comando do release),
// mesmo que ele repita o typecheck — custa alguns segundos e evita casos especiais.
const TASKS = ['typecheck', 'test', 'build'];

// Arquivos que não afetam nenhum job: documentação e o site estático.
// Qualquer outro arquivo fora dos workspaces (package.json/lockfile da raiz,
// tsconfig.base.json, workflows, .nvmrc...) é tratado como compartilhado e roda tudo.
const IGNORED = ['**/*.md', 'LICENSE', 'site/**', 'design/**'];

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const ZERO_SHA = /^0+$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const log = (msg) => process.stderr.write(`${msg}\n`);
// GIT_NO_LAZY_FETCH: no clone parcial, um SHA ausente falha na hora em vez de
// tentar buscar no remoto (o checkout roda com persist-credentials: false)
const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });

function discoverWorkspaces() {
  const root = readJson('package.json');
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
  const files = globSync(patterns.map((p) => posix.join(p, 'package.json')), {
    exclude: (f) => f.split(/[\\/]/).includes('node_modules'),
  });
  const workspaces = [];
  for (const file of new Set(files.map((f) => f.split('\\').join('/')))) {
    const pkg = readJson(file);
    if (!pkg.name) {
      log(`aviso: ${file} não tem "name"; ignorado`);
      continue;
    }
    const deps = new Set(DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
    workspaces.push({ name: pkg.name, path: posix.dirname(file), scripts: pkg.scripts ?? {}, deps });
  }
  return workspaces.sort((a, b) => a.path.localeCompare(b.path));
}

// Lista de arquivos alterados, ou null quando não dá para saber (=> roda tudo).
function changedFiles(opts) {
  if (opts.all) return { files: null, reason: '--all' };
  if (opts.files) {
    const text = readFileSync(opts.files === '-' ? 0 : opts.files, 'utf8');
    return { files: text.split('\n').map((l) => l.trim()).filter(Boolean), reason: `lista ${opts.files}` };
  }

  let base = opts.base;
  let head = opts.head ?? 'HEAD';
  let mergeBase = opts['merge-base'];
  if (!base) {
    const event = process.env.GITHUB_EVENT_NAME;
    const payload = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : {};
    head = process.env.GITHUB_SHA || head;
    if (event === 'pull_request') {
      base = payload.pull_request?.base?.sha;
      mergeBase = true;
    } else if (event === 'push') {
      base = payload.before;
      mergeBase = false;
    } else {
      return { files: null, reason: `evento ${event ?? 'desconhecido'}` };
    }
    if (!base || ZERO_SHA.test(base)) return { files: null, reason: `${event} sem commit base` };
  }

  const range = mergeBase ? `${base}...${head}` : `${base}..${head}`;
  try {
    // --no-renames: arquivo movido aparece no caminho antigo e no novo
    // (e não precisa baixar blobs no clone com filter=blob:none).
    const out = git('diff', '--name-only', '--no-renames', '-z', range, '--');
    return { files: out.split('\0').filter(Boolean), reason: `git diff ${range}` };
  } catch (err) {
    // base inalcançável (force-push, histórico raso...): melhor rodar tudo
    const detail = String(err.stderr || err.message).trim().split('\n').at(-1);
    log(`::warning::não foi possível calcular o diff ${range} (${detail}); rodando todos os workspaces`);
    return { files: null, reason: `diff ${range} falhou` };
  }
}

function plan(workspaces, files) {
  const selected = new Set();
  const why = new Map();
  const shared = [];

  if (files === null) {
    workspaces.forEach((w) => selected.add(w.name));
  } else {
    for (const file of files) {
      if (IGNORED.some((g) => matchesGlob(file, g))) continue;
      const owner = workspaces
        .filter((w) => file.startsWith(`${w.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (owner) {
        if (!selected.has(owner.name)) why.set(owner.name, `alterado (${file})`);
        selected.add(owner.name);
      } else {
        shared.push(file);
      }
    }
    if (shared.length) workspaces.forEach((w) => selected.add(w.name));
  }

  // fecha transitivamente sobre os dependentes (B depende de A => A mudou, B roda)
  const queue = [...selected];
  while (queue.length) {
    const changed = queue.shift();
    for (const w of workspaces) {
      if (!selected.has(w.name) && w.deps.has(changed)) {
        selected.add(w.name);
        why.set(w.name, `depende de ${changed}`);
        queue.push(w.name);
      }
    }
  }

  const include = [];
  for (const w of workspaces) {
    if (!selected.has(w.name)) continue;
    for (const task of TASKS) {
      if (typeof w.scripts[task] === 'string') include.push({ workspace: w.name, path: w.path, task });
    }
  }
  return { include, why, shared };
}

const { values: opts } = parseArgs({
  options: {
    all: { type: 'boolean' },
    files: { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
    'merge-base': { type: 'boolean' },
  },
});

const workspaces = discoverWorkspaces();
const { files, reason } = changedFiles(opts);
const { include, why, shared } = plan(workspaces, files);

const lines = [`origem: ${reason}${files ? ` (${files.length} arquivo(s))` : ' => todos'}`];
lines.push(`workspaces: ${workspaces.map((w) => `${w.name} (${w.path})`).join(', ') || 'nenhum'}`);
if (shared.length) lines.push(`arquivos compartilhados => todos: ${shared.slice(0, 10).join(', ')}${shared.length > 10 ? ', ...' : ''}`);
if (!shared.length) for (const [name, r] of why) lines.push(`  ${name}: ${r}`);
lines.push(include.length ? `jobs: ${include.map((e) => `${e.task} ${e.workspace}`).join(', ')}` : 'jobs: nenhum');
log(lines.join('\n'));

const matrix = JSON.stringify({ include });
process.stdout.write(`${JSON.stringify({ include }, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\nempty=${include.length === 0}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Plano do CI\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}
