import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint, ensureWorktree, restoreCheckpoint, worktreeGit } from './worktree';

function commitBase(repo: string) {
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  writeFileSync(join(repo, 'obsolete.txt'), 'remove me\n');
  worktreeGit(repo, ['add', '.']);
  worktreeGit(repo, ['commit', '-m', 'base']);
  return worktreeGit(repo, ['rev-parse', 'HEAD']);
}

test('creates a detached task worktree and snapshots staged, unstaged and untracked files', () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-worktree-'));
  try {
    const repo = join(root, 'repo');
    const workspace = join(root, 'task');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    const base = commitBase(repo);
    ensureWorktree(repo, workspace, base);
    writeFileSync(join(workspace, 'app.txt'), 'staged\n');
    worktreeGit(workspace, ['add', 'app.txt']);
    writeFileSync(join(workspace, 'app.txt'), 'final\n');
    writeFileSync(join(workspace, 'answer.txt'), '42\n');
    rmSync(join(workspace, 'obsolete.txt'));
    const checkpointSha = checkpoint(workspace, root, 'task-1', 1);
    expect(worktreeGit(workspace, ['rev-parse', `${checkpointSha}^1`])).toBe(base);
    const restored = join(root, 'restored');
    restoreCheckpoint(repo, restored, checkpointSha);
    expect(readFileSync(join(restored, 'app.txt'), 'utf8')).toBe('final\n');
    expect(readFileSync(join(restored, 'answer.txt'), 'utf8')).toBe('42\n');
    expect(existsSync(join(restored, 'obsolete.txt'))).toBe(false);
    expect(worktreeGit(restored, ['status', '--short'])).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an existing non-worktree directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-worktree-'));
  try {
    const repo = join(root, 'repo');
    const workspace = join(root, 'task');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    commitBase(repo);
    ensureWorktree(repo, workspace);
    expect(() => ensureWorktree(repo, workspace)).not.toThrow();
    writeFileSync(join(workspace, 'app.txt'), 'changed\n');
    const actual = join(root, 'existing');
    writeFileSync(actual, 'not a directory');
    expect(() => ensureWorktree(repo, actual)).toThrow('not a directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
