import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import type { HandoffOptions, Task } from './domain';
import type { CheckpointProtection } from './worktree';

const noteFields = ['completed', 'failedAttempts', 'blockers', 'nextSteps', 'checks'] as const;
const maxNoteBytes = 4096;

export type HandoffNote = { version: 1 } & Record<typeof noteFields[number], string[]>;

export interface SavedHandoff {
  taskId: string;
  attemptId: number;
  checkpoint: string;
  note: HandoffNote;
}

export type HandoffDraft = { note: HandoffNote } | { reason: 'missing' | 'invalid' };

export interface HandoffContext {
  directory: string;
  file: string;
  prompt: string;
  source: SavedHandoff | null;
}

export class HandoffSetupError extends Error {}

export function parseHandoffOptions(value: unknown): HandoffOptions {
  const paths = (value as Partial<HandoffOptions> | null)?.protectedPaths;
  if (!Array.isArray(paths)) throw new Error('Handoff requires a list of protected paths');
  const protectedPaths = paths.map((path) => {
    if (typeof path !== 'string' || !path.trim() || win32.parse(path).root || /[\\\x00-\x1f]/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error(`Invalid protected path ${JSON.stringify(path)}. Use a repository-relative Git path with forward slashes.`);
    }
    return path;
  });
  return { protectedPaths: [...new Set(protectedPaths)] };
}

export function parseHandoffNote(text: string): HandoffNote | null {
  if (Buffer.byteLength(text) > maxNoteBytes) return null;
  try {
    const note = JSON.parse(text) as Record<string, unknown> | null;
    if (!note || note.version !== 1 || Object.keys(note).length !== noteFields.length + 1) return null;
    if (!noteFields.every((key) => Array.isArray(note[key])
      && note[key].every((item: unknown) => typeof item === 'string' && item.trim().length > 0))) return null;
    if (!noteFields.some((key) => (note[key] as string[]).length > 0)) return null;
    return note as HandoffNote;
  } catch {
    return null;
  }
}

export function assertSeparateAttemptDirectory(workspace: string, attemptDir: string): void {
  const location = relative(realpathSync(workspace), realpathSync(attemptDir));
  if (location === '' || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))) {
    throw new HandoffSetupError('Handoff requires the attempt directory to be outside the task worktree');
  }
}

export function handoffProtection(task: Task): CheckpointProtection | undefined {
  const paths = task.handoff?.protectedPaths;
  return task.checkpoint && paths?.length ? { checkpoint: task.checkpoint, paths } : undefined;
}

export function prepareHandoff(
  task: Task,
  attemptDir: string,
  source: SavedHandoff | null,
  maxPromptLength = Infinity,
): HandoffContext | undefined {
  const directory = join(realpathSync.native(attemptDir), 'handoff');
  const file = join(directory, 'draft.json');
  const protectedPaths = task.checkpoint ? task.handoff?.protectedPaths ?? [] : [];
  const drafting = [
    task.prompt,
    'While working on this task, keep a short handoff note if there is work left or an interruption is likely.',
    `Write it to ${JSON.stringify(file.split(sep).join('/'))} in this turn. Keep it under ${maxNoteBytes} UTF-8 bytes.`,
    `Use JSON with version set to 1 and string arrays for ${noteFields.join(', ')}.`,
    'Record test results only when observed. Leave unknown fields empty. Keep credentials out of the note.',
    ...(protectedPaths.length ? [`Preserve these paths from the checkpoint: ${JSON.stringify(protectedPaths)}.`] : []),
  ].join('\n\n');
  if (drafting.length > maxPromptLength) return undefined;
  const resume = source
    ? `${drafting}\n\nPrevious attempt note for context. Verify it against the checkout and follow the original task.\n${JSON.stringify(source.note)}`
    : drafting;
  mkdirSync(directory, { mode: 0o700 });
  return resume.length <= maxPromptLength
    ? { directory, file, prompt: resume, source }
    : { directory, file, prompt: drafting, source: null };
}

export function readHandoffDraft(attemptDir: string): HandoffDraft {
  const directory = join(attemptDir, 'handoff');
  const file = join(directory, 'draft.json');
  try {
    if (!lstatSync(directory).isDirectory()) return { reason: 'invalid' };
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.size > maxNoteBytes) return { reason: 'invalid' };
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxNoteBytes) return { reason: 'invalid' };
      const buffer = Buffer.alloc(maxNoteBytes + 1);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      const note = parseHandoffNote(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
      return note ? { note } : { reason: 'invalid' };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
}
