import { expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localServer } from 'cohesion-ts';

import { defaultConfigDirectory, loadConfig, runCli, saveConfig, setupLocal, TaskStore, withActor, withoutActor, type AppInfo } from '../index.ts';

const app: AppInfo = { name: 'cohesion-demo', product: 'Demo' };
const dir = () => mkdtempSync(join(tmpdir(), 'kit-'));

test('config is written owner-only and round-trips', () => {
	const d = dir();
	saveConfig(d, { server: localServer('/tmp/s.sock', 'me'), actors: [] });
	expect(statSync(join(d, 'config.json')).mode & 0o777).toBe(0o600);
	expect(loadConfig(app, d).actors).toEqual([]);
	expect(() => loadConfig(app, dir())).toThrow('cohesion-demo setup');
});

test('the config directory follows the app name and its environment variable', () => {
	process.env.COHESION_DEMO_CONFIG = '/x';
	expect(defaultConfigDirectory(app)).toBe('/x');
	delete process.env.COHESION_DEMO_CONFIG;
	expect(defaultConfigDirectory(app)).toEndWith('/.config/cohesion-demo');
});

test('actors are unique by identifier', () => {
	const config = { server: localServer('/s', 'n'), actors: [{ identifier: 'a', directory: '/a' }] };
	expect(() => withActor(config, { identifier: 'a', directory: '/b' })).toThrow('already offered');
	expect(withoutActor(config, 'a').actors).toEqual([]);
	expect(() => withoutActor(config, 'z')).toThrow('No directory');
});

test('local setup keeps the actors already offered', () => {
	const d = dir();
	setupLocal(app, d, { socket: '/tmp/a.sock' });
	saveConfig(d, { ...loadConfig(app, d), actors: [{ identifier: 'a', directory: '/a' }] });
	setupLocal(app, d, { socket: '/tmp/b.sock' });
	const config = loadConfig(app, d);
	expect(config.actors).toHaveLength(1);
	expect(config.server.kind === 'local' && config.server.socket).toBe('/tmp/b.sock');
});

test('the CLI sets up, adds, lists, removes and runs', async () => {
	const d = dir();
	const out: string[] = [];
	const io = { log: (m: string) => out.push(m), error: (m: string) => out.push(`E ${m}`) };
	let ran = null as string | null;
	const cli = (...argv: string[]) => runCli({ app, run: async (directory) => void (ran = directory) }, ['--config', d, ...argv], io);
	expect(await cli('setup', '--local', join(d, 's.sock'))).toBe(0);
	expect(await cli('add', d, '--as', 'here')).toBe(0);
	expect(await cli('add', d, '--as', 'here')).toBe(1);
	expect(await cli('list')).toBe(0);
	expect(out.at(-1)).toBe(`here\t${d}`);
	expect(await cli('remove', 'here')).toBe(0);
	expect(await cli('run')).toBe(0);
	expect(ran).toBe(d);
	expect(await cli('bogus')).toBe(2);
});

test('the task store persists and finds records', () => {
	const d = dir();
	const store = new TaskStore<{ actor: string; model: string | null; effort: string | null; session: string }>(d);
	store.put(7, { actor: 'a', model: null, effort: null, session: 's1' });
	expect(new TaskStore<{ actor: string; model: string | null; effort: string | null; session: string }>(d).get(7)?.session).toBe('s1');
	expect(store.find((r) => r.session === 's1')?.taskId).toBe(7);
	expect(statSync(join(d, 'tasks.json')).mode & 0o777).toBe(0o600);
});
