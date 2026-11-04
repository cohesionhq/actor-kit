// What an actor client keeps on disk, in its config directory: how it reaches
// cohesiond (`server`, from pairing or local setup) and the directories it
// offers its agent in. Written owner-only: it holds the client's key.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Server } from 'cohesion-ts';

/** Who the client is, for its config directory and its messages. */
export interface AppInfo {
	/** The command and config directory name, such as `cohesion-claude-code`. */
	name: string;
	/** The agent's product, such as `Claude Code`. */
	product: string;
	/** Environment variable that overrides the config directory; default `COHESION_<NAME>_CONFIG`. */
	configEnv?: string;
}

/** One directory the agent works in, offered as one actor. */
export interface ActorEntry {
	/** What cohesiond names the actor by; unique among this client's actors. */
	identifier: string;
	/** An absolute path. */
	directory: string;
}

export interface Config<A extends ActorEntry = ActorEntry> {
	server: Server;
	actors: A[];
}

/** `$<configEnv>`, else `~/.config/<name>`. */
export function defaultConfigDirectory(app: AppInfo): string {
	const env = app.configEnv ?? `COHESION_${app.name.replace(/^cohesion-/, '').replace(/-/g, '_').toUpperCase()}_CONFIG`;
	return process.env[env] ?? join(homedir(), '.config', app.name);
}

export function configPath(directory: string): string {
	return join(directory, 'config.json');
}

export function hasConfig(directory: string): boolean {
	return existsSync(configPath(directory));
}

export function loadConfig<A extends ActorEntry = ActorEntry>(app: AppInfo, directory: string): Config<A> {
	const path = configPath(directory);
	if (!existsSync(path)) throw new Error(`No configuration in ${directory}; run \`${app.name} setup\` first.`);
	return JSON.parse(readFileSync(path, 'utf8')) as Config<A>;
}

export function saveConfig<A extends ActorEntry>(directory: string, config: Config<A>): void {
	writeOwnerOnly(configPath(directory), JSON.stringify(config, null, '\t') + '\n');
}

/** Writes `contents` readable only by this user, creating the directory 0700. */
export function writeOwnerOnly(path: string, contents: string): void {
	mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
	writeFileSync(path, contents, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/** `config` with `actor` offered too; refuses an identifier already offered. */
export function withActor<A extends ActorEntry>(config: Config<A>, actor: A): Config<A> {
	if (config.actors.some((offered) => offered.identifier === actor.identifier)) {
		throw new Error(`${actor.identifier} is already offered; name this one with --as.`);
	}
	return { ...config, actors: [...config.actors, actor] };
}

/** `config` without the actor `identifier`; refuses one not offered. */
export function withoutActor<A extends ActorEntry>(config: Config<A>, identifier: string): Config<A> {
	const actors = config.actors.filter((actor) => actor.identifier !== identifier);
	if (actors.length === config.actors.length) throw new Error(`No directory is offered as ${identifier}.`);
	return { ...config, actors };
}
