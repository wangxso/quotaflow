import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLab } from './git.ts';
import { drive } from './run.ts';
import { State } from './state.ts';

const lab = createLab();
const file = join(lab.root, 'phase0.sqlite');
const initial = new State(file);
initial.add('example', lab.workspace);
initial.db.close();

await drive(lab.root, 'example', 'quota');
await drive(lab.root, 'example', 'quota');
const final = new State(file);
try {
  const task = final.get('example');
  if (task.state !== 'completed') throw new Error('Fixture failed to complete');
  console.log(JSON.stringify({
    evidence: 'fault-injection fixture',
    status: task.state,
    answer: readFileSync(join(lab.workspace, 'answer.txt'), 'utf8').trim(),
    gitCheckpoint: task.checkpoint,
    events: final.events('example').map(({ id, kind, detail }) => ({ id, kind, detail: JSON.parse(detail) })),
  }, null, 2));
} finally {
  final.db.close();
}
