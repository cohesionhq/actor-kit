// Answers cohesiond's calls to a client's actors, keeping one runner per
// task it hands them. The agent-specific parts (a session, a mode, a model)
// stay with the client, behind `TaskEngine` and `TaskRunner`; routing,
// recovery of a task the client lost, and resync after a reconnect are here.

import { existsSync } from 'node:fs';

import type { ActorCall, ActorTask, ActorTaskReport, ActorTaskStatus, ActorUserContent, Client, ClientCall, ClientImage, ClientResult, Session } from 'cohesion-ts';

import type { ActorEntry } from './config.ts';
import type { TaskRecordBase, TaskStore } from './task_store.ts';
import { describe, transcriptText } from './transcript.ts';

/** One running task, as the host drives it. */
export interface TaskRunner {
	readonly id: number;
	/** Where the task stands, as this client last reported it. */
	readonly status: ActorTaskStatus;
	/** Starts a turn with `text`, or adds it to the one under way. */
	say(text: string, images: ClientImage[]): void | Promise<void>;
	/** The user's message: more to do, or a response to a request. */
	hear(content: ActorUserContent, images: ClientImage[]): void | Promise<void>;
	/** Stops the turn under way; the task is idle until the user says more. */
	stop(): Promise<void>;
	/** Runs the task in `mode` from its next step on; it persists the record. */
	setMode(mode: string): Promise<void>;
	/** Reports where the task stands, for a session that just began (cohesiond forgot). */
	resync(report: (report: ActorTaskReport) => Promise<unknown>): Promise<void>;
}

/** What a client says about its agent so the host can run its tasks. */
export interface TaskEngine<R extends TaskRecordBase, A extends ActorEntry = ActorEntry> {
	/** The agent as the transcript calls it: "Claude", "Assistant". */
	speaker: string;
	/** What the lost session is called, with its article: "a Claude Code session". */
	session: string;
	/** Shows a tool's name; default as given. */
	toolName?: (name: string) => string;
	/** The record for a task Cohesion just started; `title` is null when it took the prompt's first line. */
	start(actor: A, call: Extract<ActorCall, { kind: 'startActorTask' }>): R | Promise<R>;
	/** The record for a task cohesiond has but this client never did (`held`). Its title should be `given`. */
	recover(actor: A, held: ActorTask): R;
	/** The runner for task `taskId`, whose record is already stored. */
	open(taskId: number, record: R, actor: A, client: Client): TaskRunner;
	/** Throws if `actor` doesn't offer `mode`; returns it as the record keeps it. */
	checkMode(actor: A, mode: string): string;
	/** `record` running in `mode` (already checked), for a task with no runner. */
	withMode(record: R, mode: string): R;
}

export class TaskHost<R extends TaskRecordBase, A extends ActorEntry = ActorEntry> {
	private readonly tasks = new Map<number, TaskRunner>();
	/** Set by `ActorService`; set it yourself when you build a `Client` of your own. */
	client!: Client;

	constructor(
		private actors: A[],
		private readonly engine: TaskEngine<R, A>,
		private readonly store: TaskStore<R>,
		private readonly log: (message: string) => void,
	) {}

	setActors(actors: A[]): void {
		this.actors = actors;
	}

	/** The runner for task `taskId`, while this process has one. */
	task(taskId: number): TaskRunner | undefined {
		return this.tasks.get(taskId);
	}

	/** Every task this process runs, with where each stands. */
	get running(): { id: number; status: ActorTaskStatus }[] {
		return [...this.tasks.values()].map(({ id, status }) => ({ id, status }));
	}

	readonly onCall = async (call: ClientCall): Promise<ClientResult> => {
		const actor = this.actor(call.actor);
		switch (call.kind) {
			case 'startActorTask':
				await this.start(call, actor);
				break;
			case 'sendActorTaskMessage':
				await this.hear(call.task_id, actor, call.content, call.images ?? []);
				break;
			case 'stopActorTask':
				await this.tasks.get(call.task_id)?.stop();
				break;
			case 'setActorTaskMode':
				await this.setMode(call.task_id, actor, call.mode);
				break;
			default:
				throw new Error(`This client can't ${(call as { kind: string }).kind}.`);
		}
		this.log(`task ${call.task_id} on ${call.actor}: ${call.kind}`);
		return { kind: 'accepted' };
	};

	/** Reports each task still going on to a session that just began. */
	readonly onConnect = async (session: Session): Promise<void> => {
		for (const task of this.tasks.values()) {
			await task.resync((report) => session.report(task.id, report)).catch((error: Error) => {
				this.log(`task ${task.id}: ${error.message}`);
			});
		}
	};

	/** Opens the runner of a stored task no runner has, such as one an agent session woke up again. */
	adopt(taskId: number): TaskRunner | undefined {
		const running = this.tasks.get(taskId);
		if (running) return running;
		const kept = this.store.get(taskId);
		const actor = kept && this.actors.find((actor) => actor.identifier === kept.actor);
		return kept && actor ? this.open(taskId, kept, actor) : undefined;
	}

	private actor(identifier: string): A {
		const actor = this.actors.find((actor) => actor.identifier === identifier);
		if (!actor) throw new Error(`This client has no actor ${identifier}.`);
		if (!existsSync(actor.directory)) throw new Error(`${actor.directory} doesn't exist.`);
		return actor;
	}

	private async start(call: Extract<ActorCall, { kind: 'startActorTask' }>, actor: A): Promise<void> {
		const record = await this.engine.start(actor, call);
		this.store.put(call.task_id, record);
		// A session that can't be made (a model the agent lacks) fails the call.
		await this.open(call.task_id, record, actor).say(call.prompt, call.images ?? []);
	}

	private async setMode(taskId: number, actor: A, identifier: string): Promise<void> {
		const mode = this.engine.checkMode(actor, identifier);
		const running = this.tasks.get(taskId);
		if (running) return running.setMode(mode);
		const kept = this.store.get(taskId);
		if (kept) this.store.put(taskId, this.engine.withMode(kept, mode));
	}

	/**
	 * Hands task `taskId` what the user said, picking the task up from disk
	 * after a restart, or from Cohesion's transcript when this client never
	 * had it.
	 */
	private async hear(taskId: number, actor: A, content: ActorUserContent, images: ClientImage[]): Promise<void> {
		const running = this.tasks.get(taskId);
		if (running) return running.hear(content, images);
		const kept = this.store.get(taskId);
		if (kept) return this.open(taskId, kept, actor).hear(content, images);

		const [held, messages] = await Promise.all([
			this.client.request('getActorTask', { id: taskId }),
			this.client.request('listActorTaskMessages', { task_id: taskId }),
		]);
		const record = this.engine.recover(actor, held);
		this.store.put(taskId, record);
		await this.open(taskId, record, actor).say(
			`This task began in ${this.engine.session} that is no longer available. ` +
				'Its transcript so far, for context:\n\n' +
				transcriptText(messages, this.engine.speaker, this.engine.toolName) +
				'\n\nMy new message:\n\n' +
				describe(content),
			images,
		);
	}

	private open(taskId: number, record: R, actor: A): TaskRunner {
		const task = this.engine.open(taskId, record, actor, this.client);
		this.tasks.set(taskId, task);
		return task;
	}
}
