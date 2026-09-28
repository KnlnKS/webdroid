export class ActivityTasks {
  private nextActivity = 1;
  private nextTask = 1;
  private activities = new Map<number, { pid: number; task: number; affinity: string }>();
  attach(pid: number, task = 0, affinity = ""): { id: number; task: number } {
    if (task && ![...this.activities.values()].some(a => a.task === task)) throw new Error("Activity task is unavailable");
    const id = this.nextActivity++; task ||= this.nextTask++;
    this.activities.set(id, { pid, task, affinity }); return { id, task };
  }
  task(pid: number, id: number): number { const a = this.activities.get(id); return a?.pid === pid ? a.task : 0; }
  root(pid: number, id: number): boolean {
    const task = this.task(pid, id);
    if (!task) return false;
    for (const [candidate, activity] of this.activities) if (activity.task === task) return candidate === id;
    return false;
  }
  /** Activity.finishAffinity's activities, across processes, top first */
  affinityGroup(pid: number, id: number): { pid: number; id: number }[] {
    const task = this.task(pid, id), members = [...this.activities].filter(([, a]) => a.task === task);
    return affinityRun(members, members.findIndex(([candidate]) => candidate === id), ([, a]) => a.affinity).map(([id, a]) => ({ pid: a.pid, id }));
  }
  members(task: number): number[] { return [...new Set([...this.activities.values()].filter(a => a.task === task).map(a => a.pid))]; }
  detach(pid: number, id: number): void { if (this.task(pid, id)) this.activities.delete(id); }
  died(pid: number): void { for (const [id, a] of this.activities) if (a.pid === pid) this.activities.delete(id); }
}
/** finishActivityAffinity's walk: from `index` down the task (bottom first), stopping at the first
 *  activity of another affinity; top first */
export function affinityRun<T>(task: T[], index: number, affinityOf: (activity: T) => string): T[] {
  const run: T[] = [];
  if (index < 0) return run;
  const affinity = affinityOf(task[index]);
  for (let i = index; i >= 0 && affinityOf(task[i]) === affinity; i--) run.push(task[i]);
  return run;
}
