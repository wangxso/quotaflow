import type { BudgetPolicy, LaneConfig, Reservation } from './domain';
import type { TaskStore } from './store';

export function reserveNext(
  store: TaskStore,
  lanes: LaneConfig[],
  now = Date.now(),
  budgets: BudgetPolicy[] = [],
): Reservation | null {
  for (const task of store.listRunnable(now)) {
    const reservation = store.reserve(task.id, lanes, now, budgets);
    if (reservation) return reservation;
  }
  return null;
}
