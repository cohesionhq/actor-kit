// The run loop every actor client has: a `Client` that stays connected,
// offers what the config says now and whenever it changes (such as after
// `add`), logs where it stands, and stops on SIGINT/SIGTERM.

import { watch, type FSWatcher } from 'node:fs';

import { Client, type ClientCall, type ClientCapabilities, type ClientResult, type Session } from 'cohesion-ts';

import { loadConfig, type ActorEntry, type AppInfo, type Config } from './config.ts';

/** What the service needs of whatever answers cohesiond's calls; `SessionHost` is one. */
export interface ServiceHost<A extends ActorEntry> {
	/** Set by the service once it has a `Client`. */
	client: Client;
	onCall(call: ClientCall): Promise<ClientResult>;
	onConnect(connection: Session): Promise<void>;
	/** Told the actors on every reload of the config; a host that tracks them itself may leave it out. */
	setActors?(actors: A[]): void;
}

export interface ServiceOptions<A extends ActorEntry> {
	app: AppInfo;
	/** The config directory, watched for changes to `config.json`. */
	directory: string;
	config: Config<A>;
	host: ServiceHost<A>;
	/** What to offer for `config`: the actors' modes and models. Called at start and on every reload. */
	offers(config: Config<A>): ClientCapabilities | Promise<ClientCapabilities>;
	/** Runs after a reload's offer settles, refused or not, such as to say usage for a new actor. */
	afterOffer?(): void;
	log: (message: string) => void;
}

export class ActorService<A extends ActorEntry> {
	private config: Config<A>;
	private watcher: FSWatcher | null = null;
	private pending: ReturnType<typeof setTimeout> | undefined;

	private constructor(
		private readonly options: ServiceOptions<A>,
		readonly client: Client,
	) {
		this.config = options.config;
		options.host.client = client;
	}

	/** Builds the client with the offers for `options.config`; it connects on `run`. */
	static async create<A extends ActorEntry>(options: ServiceOptions<A>): Promise<ActorService<A>> {
		const { host, log } = options;
		const offers = await options.offers(options.config);
		const client = new Client(options.config.server, {
			offers,
			onCall: (call) => host.onCall(call),
			onConnect: (connection) => host.onConnect(connection),
			onState: (state) => {
				switch (state.kind) {
					case 'online':
						return log(`Serving as "${state.session.hello.client_name}", offering ${offers.actors.length} actors.`);
					case 'offline':
						return log(`Can't reach cohesiond (${state.error.message}); retrying in ${state.retryIn / 1000}s.`);
					case 'evicted':
						return log(
							state.reason === 'replaced'
								? 'Another session serves this client now; stopping.'
								: `This client was removed from Cohesion; run \`${options.app.name} setup\` again to pair it.`,
						);
				}
			},
		});
		return new ActorService(options, client);
	}

	/** Connects and serves until stopped or evicted. */
	async run(): Promise<void> {
		this.watcher = watch(this.options.directory, (_, file) => {
			if (file !== 'config.json') return;
			clearTimeout(this.pending);
			this.pending = setTimeout(() => void this.reload(), 200);
		});
		const stop = () => this.client.stop();
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
		try {
			await this.client.run();
		} finally {
			for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, stop);
			clearTimeout(this.pending);
			this.watcher.close();
		}
	}

	/** Reads the config again and offers what it says, such as after `add`. */
	async reload(): Promise<void> {
		const { app, directory, host, log } = this.options;
		try {
			this.config = loadConfig<A>(app, directory);
			host.setActors?.(this.config.actors);
			await this.client.offer(await this.options.offers(this.config)).catch((error: Error) => log(`Offer refused: ${error.message}`));
			this.options.afterOffer?.();
		} catch (error) {
			log(`Couldn't read the configuration: ${error instanceof Error ? error.message : error}`);
		}
	}
}

/** A logger that stamps each line with the time, to stderr. */
export function stderrLog(): (message: string) => void {
	return (message) => console.error(`${new Date().toISOString()} ${message}`);
}
