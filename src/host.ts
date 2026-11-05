// Answers cohesiond's calls to a client's actors, keeping one runner per
// actor session it hands them. The agent-specific parts (an agent session, a
// mode, a model) stay with the client, behind `SessionEngine` and
// `SessionRunner`; routing, recovery of an actor session the client lost, and
// resync after a reconnect are here.

import { existsSync } from 'node:fs';

import type { ActorCall, ActorSession, ActorSessionReport, ActorSessionStatus, ActorUserContent, Client, ClientCall, ClientImage, ClientResult, Session } from 'cohesion-ts';

import type { ActorEntry } from './config.ts';
import type { SessionRecordBase, SessionStore } from './session_store.ts';
import { describe, transcriptText } from './transcript.ts';

/** One running actor session, as the host drives it. */
export interface SessionRunner {
	readonly id: number;
	/** Where the actor session stands, as this client last reported it. */
	readonly status: ActorSessionStatus;
	/** Starts a turn with `text`, or adds it to the one under way. */
	say(text: string, images: ClientImage[]): void | Promise<void>;
	/** The user's message: more to do, or a response to a request. */
	hear(content: ActorUserContent, images: ClientImage[]): void | Promise<void>;
	/** Stops the turn under way; the actor session is idle until the user says more. */
	stop(): Promise<void>;
	/** Runs the actor session in `mode` from its next step on; it persists the record. */
	setMode(mode: string): Promise<void>;
	/** Reports where the actor session stands, for a connection that just began (cohesiond forgot). */
	resync(report: (report: ActorSessionReport) => Promise<unknown>): Promise<void>;
}

/** What a client says about its agent so the host can run its actor sessions. */
export interface SessionEngine<R extends SessionRecordBase, A extends ActorEntry = ActorEntry> {
	/** The agent as the transcript calls it: "Claude", "Assistant". */
	speaker: string;
	/** What the lost agent session is called, with its article: "a Claude Code session". */
	agentSession: string;
	/** Shows a tool's name; default as given. */
	toolName?: (name: string) => string;
	/** The record for an actor session Cohesion just started; `title` is null when it took the prompt's first line. */
	start(actor: A, call: Extract<ActorCall, { kind: 'startActorSession' }>): R | Promise<R>;
	/** The record for an actor session cohesiond has but this client never did (`held`). Its title should be `given`. */
	recover(actor: A, held: ActorSession): R;
	/** The runner for actor session `sessionId`, whose record is already stored. */
	open(sessionId: number, record: R, actor: A, client: Client): SessionRunner;
	/** Throws if `actor` doesn't offer `mode`; returns it as the record keeps it. */
	checkMode(actor: A, mode: string): string;
	/** `record` running in `mode` (already checked), for an actor session with no runner. */
	withMode(record: R, mode: string): R;
}

export class SessionHost<R extends SessionRecordBase, A extends ActorEntry = ActorEntry> {
	private readonly sessions = new Map<number, SessionRunner>();
	/** Set by `ActorService`; set it yourself when you build a `Client` of your own. */
	client!: Client;

	constructor(
		private actors: A[],
		private readonly engine: SessionEngine<R, A>,
		private readonly store: SessionStore<R>,
		private readonly log: (message: string) => void,
	) {}

	setActors(actors: A[]): void {
		this.actors = actors;
	}

	/** The runner for actor session `sessionId`, while this process has one. */
	session(sessionId: number): SessionRunner | undefined {
		return this.sessions.get(sessionId);
	}

	/** Every actor session this process runs, with where each stands. */
	get running(): { id: number; status: ActorSessionStatus }[] {
		return [...this.sessions.values()].map(({ id, status }) => ({ id, status }));
	}

	readonly onCall = async (call: ClientCall): Promise<ClientResult> => {
		const actor = this.actor(call.actor);
		switch (call.kind) {
			case 'startActorSession':
				await this.start(call, actor);
				break;
			case 'sendActorSessionMessage':
				await this.hear(call.session_id, actor, call.content, call.images ?? []);
				break;
			case 'stopActorSession':
				await this.sessions.get(call.session_id)?.stop();
				break;
			case 'setActorSessionMode':
				await this.setMode(call.session_id, actor, call.mode);
				break;
			default:
				throw new Error(`This client can't ${(call as { kind: string }).kind}.`);
		}
		this.log(`actor session ${call.session_id} on ${call.actor}: ${call.kind}`);
		return { kind: 'accepted' };
	};

	/** Reports each actor session still going on to a connection that just began. */
	readonly onConnect = async (connection: Session): Promise<void> => {
		for (const session of this.sessions.values()) {
			await session.resync((report) => connection.report(session.id, report)).catch((error: Error) => {
				this.log(`actor session ${session.id}: ${error.message}`);
			});
		}
	};

	/** Opens the runner of a stored actor session no runner has, such as one its agent session woke up again. */
	adopt(sessionId: number): SessionRunner | undefined {
		const running = this.sessions.get(sessionId);
		if (running) return running;
		const kept = this.store.get(sessionId);
		const actor = kept && this.actors.find((actor) => actor.identifier === kept.actor);
		return kept && actor ? this.open(sessionId, kept, actor) : undefined;
	}

	private actor(identifier: string): A {
		const actor = this.actors.find((actor) => actor.identifier === identifier);
		if (!actor) throw new Error(`This client has no actor ${identifier}.`);
		if (!existsSync(actor.directory)) throw new Error(`${actor.directory} doesn't exist.`);
		return actor;
	}

	private async start(call: Extract<ActorCall, { kind: 'startActorSession' }>, actor: A): Promise<void> {
		const record = await this.engine.start(actor, call);
		this.store.put(call.session_id, record);
		// An agent session that can't be made (a model the agent lacks) fails the call.
		await this.open(call.session_id, record, actor).say(call.prompt, call.images ?? []);
	}

	private async setMode(sessionId: number, actor: A, identifier: string): Promise<void> {
		const mode = this.engine.checkMode(actor, identifier);
		const running = this.sessions.get(sessionId);
		if (running) return running.setMode(mode);
		const kept = this.store.get(sessionId);
		if (kept) this.store.put(sessionId, this.engine.withMode(kept, mode));
	}

	/**
	 * Hands actor session `sessionId` what the user said, picking it up from
	 * disk after a restart, or from Cohesion's transcript when this client never
	 * had it.
	 */
	private async hear(sessionId: number, actor: A, content: ActorUserContent, images: ClientImage[]): Promise<void> {
		const running = this.sessions.get(sessionId);
		if (running) return running.hear(content, images);
		const kept = this.store.get(sessionId);
		if (kept) return this.open(sessionId, kept, actor).hear(content, images);

		const [held, messages] = await Promise.all([
			this.client.request('getActorSession', { id: sessionId }),
			this.client.request('listActorSessionMessages', { session_id: sessionId }),
		]);
		const record = this.engine.recover(actor, held);
		this.store.put(sessionId, record);
		await this.open(sessionId, record, actor).say(
			`This actor session began in ${this.engine.agentSession} that is no longer available. ` +
				'Its transcript so far, for context:\n\n' +
				transcriptText(messages, this.engine.speaker, this.engine.toolName) +
				'\n\nMy new message:\n\n' +
				describe(content),
			images,
		);
	}

	private open(sessionId: number, record: R, actor: A): SessionRunner {
		const session = this.engine.open(sessionId, record, actor, this.client);
		this.sessions.set(sessionId, session);
		return session;
	}
}
