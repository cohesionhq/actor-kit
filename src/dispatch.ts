// Starting an actor session on an actor from the client side, and reading its
// state back: the status, title and context cohesiond keeps, and its
// transcript. Wraps cohesiond's own requests (`startActorSession`,
// `getActorSession`, `listActorSessionMessages`, `sendActorSessionMessage`,
// `stopActorSession`); nothing is kept here, cohesiond is the durable side.

import type { Actor, ActorSession, ActorSessionMessage, ActorSessionStatus, Client, ImageUpload } from 'cohesion-ts';

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
	/** How often to read the actor session; default 1000 ms. */
	pollMs?: number;
	/** Gives up with an error after this long; default never. */
	timeoutMs?: number;
	/** The statuses that end the wait; default all but `working`. */
	until?: ActorSessionStatus[];
}

const SETTLED: ActorSessionStatus[] = ['needsAttention', 'idle', 'failed', 'resolved'];

/** An actor session started on an actor, and what can be read of it or done with it. */
export class DispatchedSession {
	constructor(
		private readonly client: Requester,
		/** The actor session as cohesiond last returned it: `refresh()` for now. */
		public session: ActorSession,
	) {}

	get id(): number {
		return this.session.id;
	}

	get status(): ActorSessionStatus {
		return this.session.status;
	}

	async refresh(): Promise<ActorSession> {
		return (this.session = await this.client.request('getActorSession', { id: this.id }));
	}

	messages(): Promise<ActorSessionMessage[]> {
		return this.client.request('listActorSessionMessages', { session_id: this.id });
	}

	/** The text of the actor's last text message, or `null` if it has said none. */
	async lastText(): Promise<string | null> {
		const last = (await this.messages()).findLast((message) => message.content.sender === 'actor' && message.content.kind === 'text');
		return last && last.content.kind === 'text' ? last.content.text : null;
	}

	/** More for the actor to do; an actor session done or failed starts again. */
	async say(text: string, images?: ImageUpload[]): Promise<void> {
		await this.client.request('sendActorSessionMessage', { session_id: this.id, content: { kind: 'text', text }, attachments: images ?? null });
	}

	async stop(): Promise<ActorSession> {
		return (this.session = await this.client.request('stopActorSession', { session_id: this.id }));
	}

	/** Polls until the actor session is no longer `working` (or `until`), and returns it. */
	async settled(options: WaitOptions = {}): Promise<ActorSession> {
		const { pollMs = 1000, timeoutMs, until = SETTLED } = options;
		const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
		for (let session = await this.refresh(); ; session = await this.refresh()) {
			if (until.includes(session.status)) return session;
			if (Date.now() + pollMs > deadline) throw new Error(`Actor session ${this.id} is still ${session.status} after ${timeoutMs} ms.`);
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}
}

/** Starts a new actor session on an actor, and returns it to read and drive. The actor's client must be online. */
export async function dispatchSession(client: Requester, options: DispatchOptions): Promise<DispatchedSession> {
	const actor_id = typeof options.actor === 'number' ? options.actor : await findActor(client, options.actor);
	const session = await client.request('startActorSession', {
		actor_id,
		prompt: options.prompt,
		title: options.title ?? null,
		mode: options.mode ?? null,
		model: options.model ?? null,
		effort: options.effort ?? null,
		attachments: options.images ?? null,
	});
	return new DispatchedSession(client, session);
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
