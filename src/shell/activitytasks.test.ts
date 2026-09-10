import { expect, test } from "bun:test";
import { ActivityTasks } from "./activitytasks";

test("activity tasks preserve cross-process membership and promote surviving roots", () => {
  const tasks = new ActivityTasks(), root = tasks.attach(100), child = tasks.attach(200, root.task), next = tasks.attach(200);
  expect(tasks.root(100, root.id)).toBe(true); expect(tasks.root(200, child.id)).toBe(false);
  expect(tasks.root(200, next.id)).toBe(true); expect(next.task).not.toBe(root.task);
  expect(tasks.members(root.task)).toEqual([100, 200]);
  tasks.detach(200, root.id); expect(tasks.root(100, root.id)).toBe(true);
  tasks.detach(100, root.id); expect(tasks.root(200, child.id)).toBe(true);
  tasks.died(200); expect(tasks.members(root.task)).toEqual([]); expect(tasks.members(next.task)).toEqual([]);
  expect(() => tasks.attach(100, root.task)).toThrow("unavailable");
});
