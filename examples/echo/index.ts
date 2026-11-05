#!/usr/bin/env bun
// cohesion-echo: the smallest complete actor client built on the kit. It
// offers an "agent" that answers every message by repeating it. Replace
// `EchoSession.say` with a real agent and this is a working client.
//
//   bun examples/echo/index.ts --config /tmp/echo setup --local
//   bun examples/echo/index.ts --config /tmp/echo add ~/some/project
//   bun examples/echo/index.ts --config /tmp/echo run

import {
	ActorService,
	SessionHost,
	SessionStore,
	describe,
	loadConfig,
	runCli,
	stderrLog,
	type ActorEntry,
	type AppInfo,
	type Client,
	type Config,
	type ActorUserContent,
	type ClientImage,
	type SessionEngine,
	type SessionRecordBase,
	type SessionRunner,
} from '../../index.ts';

const app: AppInfo = { name: 'cohesion-echo', product: 'Echo' };

/** 1. What survives a restart, beyond the kit's base fields: here, only the mode. */
interface EchoRecord extends SessionRecordBase {
	mode: string;
}

const MODES = [
	{ identifier: 'loud', title: 'Loud', description: 'Repeats in capitals.' },
	{ identifier: 'plain', title: 'Plain', description: 'Repeats as said.' },
];

/** 2. One actor session: what the user says goes to your agent; what it does is reported to Cohesion. */
class EchoSession implements SessionRunner {
	status: SessionRunner['status'] = 'idle';

	constructor(
		readonly id: number,
		private record: EchoRecord,
		private readonly client: Client,
		private readonly store: SessionStore<EchoRecord>,
	) {}

	async say(text: string, _images: ClientImage[]): Promise<void> {
		// cohesiond marks the actor session working itself when the user speaks.
		this.status = 'working';
		const reply = this.record.mode === 'loud' ? text.toUpperCase() : text;
		await this.client.report(this.id, { kind: 'message', content: { kind: 'text', text: reply } });
		// Always end a turn by reporting `idle`.
		this.status = 'idle';
		await this.client.report(this.id, { kind: 'status', status: 'idle' });
	}

	hear(content: ActorUserContent, images: ClientImage[]): Promise<void> {
		// A real agent would route a response to the request it is waiting on.
		return this.say(describe(content), images);
	}

	async stop(): Promise<void> {
		this.status = 'idle';
	}

	async setMode(mode: string): Promise<void> {
		this.record = { ...this.record, mode };
		this.store.put(this.id, this.record);
	}

	/** After a reconnect cohesiond has forgotten what is going on: say it again. */
	async resync(report: (report: { kind: 'status'; status: 'working' }) => Promise<unknown>): Promise<void> {
		if (this.status === 'working') await report({ kind: 'status', status: 'working' });
	}
}

/** 3. The engine: how the host makes records and runners. This is all the agent-specific glue. */
function engine(store: SessionStore<EchoRecord>): SessionEngine<EchoRecord> {
	const mode = (identifier: string | null) => MODES.find((m) => m.identifier === identifier)?.identifier ?? MODES[0]!.identifier;
	return {
		speaker: 'Echo',
		agentSession: 'an Echo session',
		start: (actor, call) => ({
			actor: actor.identifier,
			model: call.model,
			effort: call.effort,
			mode: mode(call.mode),
			titled: call.title ? 'given' : 'pending',
			...(call.title ? { title: call.title } : {}),
		}),
		recover: (actor, held) => ({ actor: actor.identifier, model: held.model, effort: held.effort, mode: mode(held.mode), titled: 'given', title: held.title }),
		checkMode: (_, identifier) => {
			if (!MODES.some((m) => m.identifier === identifier)) throw new Error(`Echo has no mode ${identifier}.`);
			return identifier;
		},
		withMode: (record, identifier) => ({ ...record, mode: identifier }),
		open: (id, record, _actor, client) => new EchoSession(id, record, client, store),
	};
}

/** 4. What to offer cohesiond: one actor per directory. */
const offers = (config: Config) => ({
	actors: config.actors.map(({ identifier, directory }) => ({
		identifier,
		product: app.product,
		scope: directory,
		modes: MODES,
		models: [],
	})),
});

/** 5. Wire it together, and let the kit's command line do the rest. */
process.exit(
	await runCli({
		app,
		run: async (directory) => {
			const log = stderrLog();
			const config = loadConfig<ActorEntry>(app, directory);
			const store = new SessionStore<EchoRecord>(directory);
			const host = new SessionHost(config.actors, engine(store), store, log);
			const service = await ActorService.create({ app, directory, config, host, offers, log });
			await service.run();
		},
	}),
);
