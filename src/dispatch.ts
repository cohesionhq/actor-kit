// Starting a task on an actor from the client side, and reading its state
// back: the status, title and context cohesiond keeps, and its transcript.
// Wraps cohesiond's own requests (`startActorTask`, `getActorTask`,
// `listActorTaskMessages`, `sendActorTaskMessage`, `stopActorTask`); nothing
// is kept here, cohesiond is the durable side.

import type { Actor, ActorTask, ActorTaskMessage, ActorTaskStatus, Client, ImageUpload } from 'cohesion-ts';

/** The requests dispatching needs: a `Client` or a `Session`. */
export type Requester = Pick<Client, 'request'>;

export interface DispatchOptions {
	/** An actor's id, or the one actor the daemon lists with this identifier (and `product`, when given). */
	actor: number | { identifier: string; product?: string };
	prompt: string;
	title?: string;
	mode?: string;
	model?: string;
	effort?: string;
	images?: ImageUpload[];
}

export interface WaitOptions {
	/** How often to read the task; default 1000 ms. */
	pollMs?: number;
	/** Gives up with an error after this long; default never. */
	timeoutMs?: number;
	/** The statuses that end the wait; default all but `working`. */
	until?: ActorTaskStatus[];
}

const SETTLED: ActorTaskStatus[] = ['needsAttention', 'idle', 'failed', 'resolved'];

/** A task started on an actor, and what can be read of it or done with it. */
export class DispatchedTask {
	constructor(
		private readonly client: Requester,
		/** The task as cohesiond last returned it: `refresh()` for now. */
		public task: ActorTask,
	) {}

	get id(): number {
		return this.task.id;
	}

	get status(): ActorTaskStatus {
		return this.task.status;
	}

	async refresh(): Promise<ActorTask> {
		return (this.task = await this.client.request('getActorTask', { id: this.id }));
	}

	messages(): Promise<ActorTaskMessage[]> {
		return this.client.request('listActorTaskMessages', { task_id: this.id });
	}

	/** The text of the actor's last text message, or `null` if it has said none. */
	async lastText(): Promise<string | null> {
		const last = (await this.messages()).findLast((message) => message.content.sender === 'actor' && message.content.kind === 'text');
		return last && last.content.kind === 'text' ? last.content.text : null;
	}

	/** More for the actor to do; a task done or failed starts again. */
	async say(text: string, images?: ImageUpload[]): Promise<void> {
		await this.client.request('sendActorTaskMessage', { task_id: this.id, content: { kind: 'text', text }, attachments: images ?? null });
	}

	async stop(): Promise<ActorTask> {
		return (this.task = await this.client.request('stopActorTask', { task_id: this.id }));
	}

	/** Polls until the task is no longer `working` (or `until`), and returns it. */
	async settled(options: WaitOptions = {}): Promise<ActorTask> {
		const { pollMs = 1000, timeoutMs, until = SETTLED } = options;
		const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
		for (let task = await this.refresh(); ; task = await this.refresh()) {
			if (until.includes(task.status)) return task;
			if (Date.now() + pollMs > deadline) throw new Error(`Task ${this.id} is still ${task.status} after ${timeoutMs} ms.`);
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}
}

/** Hands an actor a new task, and returns it to read and drive. The actor's client must be online. */
export async function dispatchTask(client: Requester, options: DispatchOptions): Promise<DispatchedTask> {
	const actor_id = typeof options.actor === 'number' ? options.actor : await findActor(client, options.actor);
	const task = await client.request('startActorTask', {
		actor_id,
		prompt: options.prompt,
		title: options.title ?? null,
		mode: options.mode ?? null,
		model: options.model ?? null,
		effort: options.effort ?? null,
		attachments: options.images ?? null,
	});
	return new DispatchedTask(client, task);
}

async function findActor(client: Requester, wanted: { identifier: string; product?: string }): Promise<number> {
	const matches = (await client.request('listActors')).filter(
		(actor: Actor) => !actor.deleted && actor.identifier === wanted.identifier && (wanted.product === undefined || actor.product === wanted.product),
	);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `${matches.length} actors are named ${wanted.identifier}; give an id.` : `No actor is named ${wanted.identifier}.`);
	}
	return matches[0]!.id;
}
