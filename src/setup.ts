// Registering with cohesiond: pairing with a setup code (a daemon elsewhere,
// mutual TLS) or a local key (a daemon on this machine). Both keep the
// result, `server`, in the config, leaving the actors already offered alone.

import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { defaultSocketPath, localServer, pair } from 'cohesion-ts';

import { hasConfig, loadConfig, saveConfig, type ActorEntry, type AppInfo } from './config.ts';

/** The name a client is listed under unless told one: this machine's. */
export function defaultClientName(): string {
	return hostname().replace(/\.local$/, '');
}

/** Uses the cohesiond on `socket` (default: where it listens unless told otherwise). Returns what to tell the user. */
export function setupLocal(app: AppInfo, directory: string, options: { socket?: string; name?: string } = {}): string {
	const socket = resolve(options.socket ?? defaultSocketPath());
	saveConfig(directory, { server: localServer(socket, options.name ?? defaultClientName()), actors: existing(app, directory) });
	return `Using cohesiond at ${socket}; configuration saved to ${directory}.`;
}

/** Pairs with the cohesiond `setupCode` names. The code works once. Returns what to tell the user. */
export async function setupPaired(app: AppInfo, directory: string, setupCode: string, options: { name?: string } = {}): Promise<string> {
	const { server, client } = await pair(setupCode, options.name ?? defaultClientName());
	saveConfig(directory, { server, actors: existing(app, directory) });
	return `Paired as "${client.client_name}"; configuration saved to ${directory}.`;
}

function existing(app: AppInfo, directory: string): ActorEntry[] {
	return hasConfig(directory) ? loadConfig(app, directory).actors : [];
}
