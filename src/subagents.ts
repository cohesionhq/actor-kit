// Subagents: the nested sessions an actor launches from inside one of its
// sessions (a Task tool, an agent thread, a child session). cohesiond gives
// one no id for the client to keep: the client reports on it under the actor
// session Cohesion started, naming it by the agent's own id (`subagent`), and
// says `launch` first. State hangs off the parent's runner, in a `Subagents`;
// the host and the store stay flat, one entry per Cohesion session.
//
// cohesion-ts does not declare any of this yet, so the shapes live here and
// go out through `Client.report`, which spreads a report into its frame:
// `subagent` rides along, and a report without one is byte-identical to before.

import type { ActorSaidContent, ActorSessionMessage, ActorSessionReport, ActorSessionStatus, Client, ClientCall, ClientImage, ContextUsage, Session } from 'cohesion-ts';

export const SUBAGENT_LIMIT = 256;
export const SUBAGENT_DEPTH_LIMIT = 4;
export const SUBAGENT_MESSAGES_LIMIT = 2000;
const KEY_BYTES = 256;
const TYPE_BYTES = 64;
const MODEL_BYTES = 128;

/**
 * Says a subagent exists, or more of one: an upsert, sent before any other
 * report about it. The first makes it, `working`; a repeat updates what it
 * says and leaves the status alone.
 */
export interface SubagentLaunch {
	kind: 'launch';
	/** What it is doing; not blank. */
	title: string;
	/** The launching subagent's key; `null` or left out: the session itself. A repeat can't move it. */
	parent?: string | null;
	/** The `toolUse` message one level up that launched it: the id its report returned. */
	message_id?: number | null;
	/** What kind of subagent, as the agent names it: "Explore". */
	agent_type?: string | null;
	/** The model it runs on; left out: the session's. */
	model?: string | null;
	/** Whether it goes on after the tool use that launched it ended. */
	background?: boolean;
}

/** A report about a session, or `launch` about a subagent. */
export type SubagentReport = ActorSessionReport | SubagentLaunch;

/** Sends a report for one session, to `subagent` when given. */
export type AddressedReport = (report: SubagentReport, subagent?: string) => Promise<unknown>;

/** `sendActorSessionMessage` as the daemon now sends it: `subagent` names the child whose request it answers. */
export type HeardCall = Extract<ClientCall, { kind: 'sendActorSessionMessage' }> & { subagent?: string };

/** The subagent a `sendActorSessionMessage` is for, or `undefined` for the session itself. */
export function addressedTo(call: Extract<ClientCall, { kind: 'sendActorSessionMessage' }>): string | undefined {
	return (call as HeardCall).subagent || undefined;
}

/** Reports on actor session `sessionId`, to `subagent` when given. A message resolves with the message stored. */
export function reportTo(client: Pick<Client, 'report'> | Pick<Session, 'report'>, sessionId: number, report: SubagentReport, subagent?: string): Promise<ActorSessionMessage | void> {
	const frame = (subagent === undefined ? report : { ...report, subagent }) as ActorSessionReport;
	return (client.report as (id: number, report: ActorSessionReport) => Promise<ActorSessionMessage | void>)(sessionId, frame);
}

/** A report function for `connection` and session `sessionId`, as `SessionRunner.resync` takes. */
export function addressedReport(client: Pick<Client, 'report'> | Pick<Session, 'report'>, sessionId: number): AddressedReport {
	return (report, subagent) => reportTo(client, sessionId, report, subagent);
}

/** `text` cut to at most `bytes` UTF-8 bytes, on a character boundary. */
export function cutBytes(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	let out = '';
	for (const char of text) {
		if (Buffer.byteLength(out + char) > bytes) break;
		out += char;
	}
	return out;
}

interface Known {
	launch: SubagentLaunch;
	status: ActorSessionStatus;
	depth: number;
}

/**
 * The subagents one actor session has launched, as this process knows them,
 * and the reports about them. One per `SessionRunner`.
 */
export class Subagents {
	private readonly known = new Map<string, Known>();

	constructor(
		private readonly send: AddressedReport,
	) {}

	/** Builds one that reports through `client` for session `sessionId`. */
	static of(client: Pick<Client, 'report'>, sessionId: number): Subagents {
		return new Subagents(addressedReport(client, sessionId));
	}

	has(key: string): boolean {
		return this.known.has(key);
	}

	get keys(): string[] {
		return [...this.known.keys()];
	}

	status(key: string): ActorSessionStatus | undefined {
		return this.known.get(key)?.status;
	}

	/**
	 * Launches `key`, or says more of it (an upsert). The parent, when
	 * given, must have been launched; limits are checked here so a refusal
	 * doesn't come back as a surprise. Settles once cohesiond has it.
	 */
	async launch(key: string, launch: Omit<SubagentLaunch, 'kind'>): Promise<void> {
		if (!key || Buffer.byteLength(key) > KEY_BYTES) throw new Error(`A subagent's key is 1 to ${KEY_BYTES} bytes.`);
		const before = this.known.get(key);
		const parent = before ? before.launch.parent ?? null : launch.parent ?? null;
		const above = parent === null ? undefined : this.known.get(parent);
		if (parent !== null && !above) throw new Error(`Launch subagent "${parent}" first.`);
		const depth = (above?.depth ?? 0) + 1;
		if (depth > SUBAGENT_DEPTH_LIMIT) throw new Error(`Subagents go ${SUBAGENT_DEPTH_LIMIT} deep at most.`);
		if (!before && this.known.size >= SUBAGENT_LIMIT) throw new Error(`A session has ${SUBAGENT_LIMIT} subagents at most.`);
		const said: SubagentLaunch = {
			kind: 'launch',
			title: launch.title,
			parent,
			message_id: launch.message_id ?? null,
			agent_type: launch.agent_type == null ? null : cutBytes(launch.agent_type, TYPE_BYTES),
			model: launch.model == null ? null : cutBytes(launch.model, MODEL_BYTES),
			background: launch.background ?? false,
		};
		await this.send(said, key);
		this.known.set(key, { launch: said, status: before?.status ?? 'working', depth });
	}

	/** A message in subagent `key`'s transcript; resolves with the one stored. */
	message(key: string, content: ActorSaidContent, images?: ClientImage[]): Promise<ActorSessionMessage> {
		return this.send({ kind: 'message', content, ...(images?.length ? { images } : {}) }, this.need(key)) as Promise<ActorSessionMessage>;
	}

	/** Where subagent `key` stands. `idle` shows as "Done"; a killed task can only be `idle`. */
	async setStatus(key: string, status: ActorSessionStatus): Promise<void> {
		const known = this.known.get(this.need(key))!;
		await this.send({ kind: 'status', status }, key);
		known.status = status;
	}

	/** Marks subagent `key` working; a subagent shows no activity. */
	async progress(key: string): Promise<void> {
		const known = this.known.get(this.need(key))!;
		await this.send({ kind: 'progress', progress: null }, key);
		known.status = 'working';
	}

	/** The tool use `messageId` in subagent `key`'s transcript has finished. */
	async end(key: string, messageId: number): Promise<void> {
		await this.send({ kind: 'end', message_id: messageId }, this.need(key));
	}

	async context(key: string, context: ContextUsage): Promise<void> {
		await this.send({ kind: 'context', context }, this.need(key));
	}

	async title(key: string, title: string): Promise<void> {
		const known = this.known.get(this.need(key))!;
		await this.send({ kind: 'title', title }, key);
		known.launch = { ...known.launch, title };
	}

	/** Stops remembering `key` and the subagents under it, as when its agent forgets it. */
	forget(key: string): void {
		this.known.delete(key);
		for (const [child, known] of [...this.known]) if (known.launch.parent === key) this.forget(child);
	}

	/**
	 * Says again every subagent this process still has, parents first, to a
	 * connection that just began: cohesiond settled the working ones `idle`
	 * when the last one dropped, so each one's status is said too. Failures
	 * of one don't stop the others; the first is thrown at the end.
	 */
	async resync(report: AddressedReport = this.send): Promise<void> {
		let failure: unknown;
		for (const [key, { launch, status }] of this.known) {
			try {
				await report(launch, key);
				await report({ kind: 'status', status }, key);
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure) throw failure;
	}

	private need(key: string): string {
		if (!this.known.has(key)) throw new Error(`Launch subagent "${key}" first.`);
		return key;
	}
}
