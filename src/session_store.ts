// The actor sessions a client has worked on, kept on disk by Cohesion's id for
// each, so a restart picks each one's agent session up rather than starting
// anew. The kit owns the fields every agent needs; the client adds its own
// through `R` (an agent session id, a mode in the agent's terms).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeOwnerOnly } from './config.ts';

/** What every client keeps of an actor session. */
export interface SessionRecordBase {
	/** The actor's identifier. */
	actor: string;
	/** `null` for the agent's default. */
	model: string | null;
	effort: string | null;
	/**
	 * Whose title the actor session has: `given` when Cohesion started it with
	 * one (or it was picked up from an agent session gone), so it is never replaced;
	 * `pending` when Cohesion took the prompt's first line, so the agent's own
	 * title replaces it. Left out for an actor session from before titles.
	 */
	titled?: 'given' | 'pending';
	/** The title given, or else the one last said to cohesiond. */
	title?: string;
}

export class SessionStore<R extends SessionRecordBase> {
	private readonly path: string;
	private readonly sessions: Record<string, R>;

	constructor(directory: string) {
		this.path = join(directory, 'sessions.json');
		this.sessions = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
	}

	get(sessionId: number): R | undefined {
		return this.sessions[sessionId];
	}

	put(sessionId: number, record: R): void {
		this.sessions[sessionId] = record;
		writeOwnerOnly(this.path, JSON.stringify(this.sessions, null, '\t') + '\n');
	}

	/** The first actor session whose record `matches`, such as the one running in an agent session. */
	find(matches: (record: R) => boolean): { sessionId: number; record: R } | undefined {
		for (const [id, record] of Object.entries(this.sessions)) if (matches(record)) return { sessionId: Number(id), record };
		return undefined;
	}
}
