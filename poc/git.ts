import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function git(workspace: string, args: string[], index?: string, missingOkay = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  if (index) env.GIT_INDEX_FILE = index;
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.quota-flow-no-hooks',
    '-c', 'user.name=QuotaFlow Phase 0', '-c', 'user.email=phase0@localhost', '-C', workspace, ...args], {
    env, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(missingOkay && result.status === 1)) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function createLab(directory = process.env.QUOTAFLOW_LAB_DIR ?? tmpdir()) {
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'quotaflow-'));
  const repo = join(root, 'base');
  mkdirSync(repo);
  git(repo, ['init', '--initial-branch=main']);
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  writeFileSync(join(repo, 'obsolete.txt'), 'remove in attempt one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'Create synthetic project']);
  return { root, repo, workspace: worktree(repo, join(root, 'task')) };
}

export function worktree(repo: string, path: string, base = 'HEAD') {
  git(repo, ['worktree', 'add', '--detach', path, base]);
  return path;
}

const allowed = new Set(['app.txt', 'handoff.txt', 'obsolete.txt', 'answer.txt']);

export function workingTree(workspace: string, directory: string) {
  const paths = git(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  for (const path of paths) {
    const fullPath = join(workspace, path);
    const isRegular = !existsSync(fullPath) || lstatSync(fullPath).isFile();
    if (!allowed.has(path) || !isRegular) throw new Error('File is outside the Phase 0 fixture contract');
  }
  const folder = mkdtempSync(join(directory, 'index-'));
  const index = join(folder, 'index');
  try {
    git(workspace, ['read-tree', 'HEAD'], index);
    git(workspace, ['add', '-A', '.'], index);
    return git(workspace, ['write-tree'], index);
  } finally {
    rmSync(index, { force: true });
    rmSync(index + '.lock', { force: true });
    rmdirSync(folder);
  }
}

export function checkpoint(workspace: string, directory: string, attempt: number) {
  const reference = `refs/quotaflow/phase0/attempt-${attempt}`;
  const base = git(workspace, ['rev-parse', 'HEAD']);
  const tree = workingTree(workspace, directory);
  const staged = git(workspace, ['write-tree']);
  const existing = () => {
    const sha = git(workspace, ['rev-parse', '--verify', '--quiet', reference], undefined, true);
    if (sha && git(workspace, ['rev-parse', `${sha}^1`, `${sha}^2^{tree}`, `${sha}^{tree}`]) !== [base, staged, tree].join('\n')) {
      throw new Error('Existing checkpoint disagrees with the stopped workspace');
    }
    return sha;
  };
  const prior = existing();
  if (prior) return prior;
  const stageCommit = git(workspace, ['commit-tree', staged, '-p', base, '-m', `Attempt ${attempt} index`]);
  const snapshot = git(workspace, ['commit-tree', tree, '-p', base, '-p', stageCommit, '-m', `Attempt ${attempt} workspace`]);
  try {
    git(workspace, ['update-ref', reference, snapshot, '0'.repeat(base.length)]);
    return snapshot;
  } catch (error) {
    const concurrent = existing();
    if (concurrent) return concurrent;
    throw error;
  }
}

export function verifyCheckpoint(path: string, work: string, sha: string) {
  if (git(path, ['rev-parse', 'HEAD']) !== git(path, ['rev-parse', `${sha}^1`]) ||
      git(path, ['write-tree']) !== git(path, ['rev-parse', `${sha}^2^{tree}`]) ||
      workingTree(path, work) !== git(path, ['rev-parse', `${sha}^{tree}`])) {
    throw new Error('Worktree does not match the stored checkpoint');
  }
}

export function restoreNewWorktree(repo: string, path: string, sha: string) {
  worktree(repo, path, `${sha}^1`);
  git(path, ['restore', '--source', sha, '--staged', '--worktree', '--', '.']);
  git(path, ['read-tree', `${sha}^2^{tree}`]);
  return path;
}
