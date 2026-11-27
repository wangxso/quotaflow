import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function git(cwd: string, args: string[], index?: string): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  if (index) env.GIT_INDEX_FILE = index;
  const result = spawnSync('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'user.name=QuotaFlow',
    '-c', 'user.email=phase1@localhost',
    '-C', cwd,
    ...args,
  ], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

function gitOrNull(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function commitExists(repoPath: string, revision: string): boolean {
  return gitOrNull(resolve(repoPath), ['cat-file', '-e', `${revision}^{commit}`]) !== null;
}

export function currentCommit(repoPath: string): string | null {
  return gitOrNull(resolve(repoPath), ['rev-parse', 'HEAD']);
}

export function ensureWorktree(repoPath: string, workspacePath: string, base = 'HEAD'): string {
  const repo = resolve(repoPath);
  const workspace = resolve(workspacePath);
  if (existsSync(workspace)) {
    if (!lstatSync(workspace).isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${workspace}`);
    }
    const root = gitOrNull(workspace, ['rev-parse', '--show-toplevel']);
    if (root && realpathSync(root) === realpathSync(workspace)) return workspace;
    throw new Error(`Workspace path already exists and is not a Git worktree: ${workspace}`);
  }
  mkdirSync(dirname(workspace), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', workspace, base]);
  return workspace;
}

function workingTree(workspace: string, directory: string): string {
  const paths = git(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  for (const path of paths) {
    const fullPath = join(workspace, path);
    if (existsSync(fullPath) && !lstatSync(fullPath).isFile()) {
      throw new Error(`Checkpoint path is not a regular file: ${path}`);
    }
  }
  const temp = mkdtempSync(join(directory, 'index-'));
  const index = join(temp, 'index');
  try {
    git(workspace, ['read-tree', 'HEAD'], index);
    git(workspace, ['add', '-A', '.'], index);
    return git(workspace, ['write-tree'], index);
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

export interface CheckpointProtection {
  checkpoint: string;
  paths: string[];
}

export class ProtectedPathsChangedError extends Error {
  constructor(readonly paths: string[]) {
    super(`Protected paths changed since the handoff checkpoint: ${paths.join(', ')}`);
  }
}

function checkProtectedTree(workspace: string, tree: string, protection: CheckpointProtection) {
  const paths = git(workspace, [
    '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z',
    protection.checkpoint, tree, '--', ...protection.paths,
  ]).split('\0').filter(Boolean);
  if (paths.length) throw new ProtectedPathsChangedError(paths);
}

export function verifyProtectedPaths(workspace: string, directory: string, protection: CheckpointProtection): void {
  mkdirSync(directory, { recursive: true });
  checkProtectedTree(workspace, workingTree(workspace, directory), protection);
}

export function checkpoint(
  workspacePath: string, directory: string, taskId: string, attemptId: number, protection?: CheckpointProtection,
): string {
  const workspace = resolve(workspacePath);
  const checkpointRoot = resolve(directory);
  mkdirSync(checkpointRoot, { recursive: true });
  const base = git(workspace, ['rev-parse', 'HEAD']);
  const tree = workingTree(workspace, checkpointRoot);
  if (protection) checkProtectedTree(workspace, tree, protection);
  const ref = `refs/quotaflow/attempts/${taskId}/${attemptId}`;
  const existing = gitOrNull(workspace, ['rev-parse', '--verify', '--quiet', ref]);
  if (existing) {
    const existingTree = git(workspace, ['rev-parse', `${existing}^{tree}`]);
    if (existingTree !== tree) throw new Error(`Existing checkpoint ${ref} disagrees with the workspace`);
    return existing;
  }
  const snapshot = git(workspace, ['commit-tree', tree, '-p', base, '-m', `QuotaFlow attempt ${attemptId}`]);
  try {
    git(workspace, ['update-ref', ref, snapshot, '0'.repeat(base.length)]);
    return snapshot;
  } catch (error) {
    const concurrent = gitOrNull(workspace, ['rev-parse', '--verify', '--quiet', ref]);
    if (concurrent && git(workspace, ['rev-parse', `${concurrent}^{tree}`]) === tree) return concurrent;
    throw error;
  }
}

export function restoreCheckpoint(repoPath: string, workspacePath: string, checkpointSha: string): string {
  const workspace = resolve(workspacePath);
  if (existsSync(workspace)) throw new Error(`Restore path already exists: ${workspace}`);
  git(resolve(repoPath), ['worktree', 'add', '--detach', workspace, checkpointSha]);
  return workspace;
}

export function worktreeGit(workspacePath: string, args: string[]): string {
  return git(resolve(workspacePath), args);
}
