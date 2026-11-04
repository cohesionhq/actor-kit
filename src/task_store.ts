// The tasks a client has worked on, kept on disk by Cohesion's id for each,
// so a restart picks each task's agent session up rather than starting anew.
// The kit owns the fields every agent needs; the client adds its own through
// `R` (a session id, a mode in the agent's terms).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeOwnerOnly } from './config.ts';

/** What every client keeps of a task. */
export interface TaskRecordBase {
	/** The actor's identifier. */
	actor: string;
	/** `null` for the agent's default. */
	model: string | null;
	effort: string | null;
	/**
	 * Whose title the task has: `given` when Cohesion started it with one (or
	 * it was picked up from a session gone), so it is never replaced;
	 * `pending` when Cohesion took the prompt's first line, so the agent's own
	 * title replaces it. Left out for a task from before titles.
	 */
	titled?: 'given' | 'pending';
	/** The title given, or else the one last said to cohesiond. */
	title?: string;
}

export class TaskStore<R extends TaskRecordBase> {
	private readonly path: string;
	private readonly tasks: Record<string, R>;

	constructor(directory: string) {
		this.path = join(directory, 'tasks.json');
		this.tasks = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
	}

	get(taskId: number): R | undefined {
		return this.tasks[taskId];
	}

	put(taskId: number, record: R): void {
		this.tasks[taskId] = record;
		writeOwnerOnly(this.path, JSON.stringify(this.tasks, null, '\t') + '\n');
	}

	/** The first task whose record `matches`, such as the one running in an agent session. */
	find(matches: (record: R) => boolean): { taskId: number; record: R } | undefined {
		for (const [id, record] of Object.entries(this.tasks)) if (matches(record)) return { taskId: Number(id), record };
		return undefined;
	}
}
