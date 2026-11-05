// The command line every actor client shares: set up (pair or local), add and
// remove the directories offered, list them, and run. `run` is the client's.

import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { defaultConfigDirectory, loadConfig, saveConfig, withActor, withoutActor, type ActorEntry, type AppInfo } from './config.ts';
import { setupLocal, setupPaired } from './setup.ts';

export interface CliOptions {
	app: AppInfo;
	/** Connects and serves; `directory` is the config directory in use. */
	run(directory: string): Promise<void>;
}

export interface CliIo {
	log(message: string): void;
	error(message: string): void;
}

export function usage(app: AppInfo): string {
	return `usage: ${app.name} [--config <dir>] <command>

  setup --local [<socket>] [--name <name>]   Use the cohesiond on this machine
  setup <setup-code> [--name <name>]         Pair with a cohesiond elsewhere
  add <directory> [--as <identifier>]        Offer ${app.product} in a directory
  remove <identifier>                        Stop offering one
  list                                       List the directories offered
  run                                        Connect, and run Cohesion's actor sessions`;
}

/** Runs the command in `argv`; returns the process's exit code. */
export async function runCli(options: CliOptions, argv: string[] = process.argv.slice(2), io: CliIo = { log: console.log, error: console.error }): Promise<number> {
	const { app } = options;
	const USAGE = usage(app);
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			local: { type: 'boolean' },
			name: { type: 'string' },
			as: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
	});
	const directory = values.config ? resolve(values.config) : defaultConfigDirectory(app);
	const [command, argument] = positionals;
	try {
		switch (values.help ? undefined : command) {
			case 'setup':
				if (values.local) io.log(setupLocal(app, directory, { socket: argument, name: values.name }));
				else if (argument) io.log(await setupPaired(app, directory, argument, { name: values.name }));
				else throw new Error(USAGE);
				return 0;
			case 'add': {
				if (!argument) throw new Error(USAGE);
				const path = resolve(argument);
				if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${path} isn't a directory.`);
				const identifier = values.as ?? basename(path);
				const actor: ActorEntry = { identifier, directory: path };
				saveConfig(directory, withActor(loadConfig(app, directory), actor));
				io.log(`Offering ${app.product} in ${path} as ${identifier}.`);
				return 0;
			}
			case 'remove':
				if (!argument) throw new Error(USAGE);
				saveConfig(directory, withoutActor(loadConfig(app, directory), argument));
				io.log(`No longer offering ${argument}.`);
				return 0;
			case 'list':
				for (const actor of loadConfig(app, directory).actors) io.log(`${actor.identifier}\t${actor.directory}`);
				return 0;
			case 'run':
				await options.run(directory);
				return 0;
			default:
				io.log(USAGE);
				return values.help ? 0 : 2;
		}
	} catch (error) {
		io.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
