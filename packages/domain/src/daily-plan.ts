import type { SessionPlan } from "@langtut/contracts";

export type DailyTaskKind = "prepare" | "vocabulary_lesson" | "exercise";
export type DailyTaskStatus = "pending" | "completed";
export type DailyTaskResult = "correct" | "near_correct" | "incorrect";

export interface DailyTask {
  id: string;
  kind: DailyTaskKind;
  moduleId: string;
  title: string;
  activityId?: string;
  evidenceTargets: string[];
  status: DailyTaskStatus;
  completedWork: number;
  expectedWork: number;
  retryOf?: string;
}

export interface DailyPlan {
  id: string;
  packageId: string;
  date: string;
  sessionPlan: SessionPlan;
  tasks: DailyTask[];
  createdAt: string;
  updatedAt: string;
}

export interface DailyPlanProgress {
  completedWork: number;
  expectedWork: number;
  percent: number;
  remainingTasks: number;
  isComplete: boolean;
}

export function localDay(value = new Date()): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

export function dailyPlanProgress(plan: DailyPlan): DailyPlanProgress {
  const completedWork = plan.tasks.reduce((total, task) => total + task.completedWork, 0);
  const expectedWork = plan.tasks.reduce((total, task) => total + task.expectedWork, 0);
  const remainingTasks = plan.tasks.filter((task) => task.status === "pending").length;
  return { completedWork, expectedWork, percent: expectedWork ? Math.round(completedWork / expectedWork * 100) : 100, remainingTasks, isComplete: remainingTasks === 0 };
}

export function nextDailyTask(plan: DailyPlan): DailyTask | undefined {
  return plan.tasks.find((task) => task.status === "pending");
}

/** Completes one concrete unit and schedules visible rework after a weak result. */
export function completeDailyTask(plan: DailyPlan, taskId: string, result: DailyTaskResult, updatedAt = new Date().toISOString()): DailyPlan {
  const index = plan.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error("unknown_daily_task");
  const task = plan.tasks[index];
  if (task.status === "completed") return plan;
  const completed: DailyTask = { ...task, status: "completed", completedWork: task.expectedWork };
  const tasks = [...plan.tasks.slice(0, index), completed, ...plan.tasks.slice(index + 1)];
  if (result !== "correct") {
    const retry: DailyTask = {
      ...task,
      id: `${task.id}:retry:${crypto.randomUUID()}`,
      title: `Wiederholen: ${task.title}`,
      status: "pending",
      completedWork: 0,
      expectedWork: task.expectedWork,
      retryOf: task.id,
    };
    tasks.splice(index + 1, 0, retry);
  }
  return { ...plan, tasks, updatedAt };
}
