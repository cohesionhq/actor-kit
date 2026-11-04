import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActorTaskMessage, ActorUserContent, Client, ClientCall } from 'cohesion-ts';

import { describe, sendable, TaskHost, TaskStore, transcriptText, type TaskEngine, type TaskRecordBase, type TaskRunner } from '../index.ts';

interface Record extends TaskRecordBase {
	mode: string;
}

function setup(kept?: Record) {
	const dir = mkdtempSync(join(tmpdir(), 'kit-'));
	const said: string[] = [];
	const stopped: number[] = [];
	const store = new TaskStore<Record>(dir);
	if (kept) store.put(1, kept);
	const engine: TaskEngine<Record> = {
		speaker: 'Bot',
		session: 'a Bot session',
		start: (actor, call) => ({ actor: actor.identifier, model: call.model, effort: call.effort, mode: call.mode ?? 'default', titled: 'pending' }),
		recover: (actor, held) => ({ actor: actor.identifier, model: held.model, effort: held.effort, mode: held.mode ?? 'default', titled: 'given' }),
		checkMode: (_, mode) => {
			if (mode !== 'plan' && mode !== 'default') throw new Error(`no mode ${mode}`);
			return mode;
		},
		withMode: (record, mode) => ({ ...record, mode }),
		open: (id): TaskRunner => ({
			id,
			status: 'idle',
			say: (text) => void said.push(`say:${text}`),
			hear: (content) => void said.push(`hear:${describe(content)}`),
			stop: async () => void stopped.push(id),
			setMode: async (mode) => void said.push(`mode:${mode}`),
			resync: async () => {},
		}),
	};
	const host = new TaskHost([{ identifier: 'a', directory: dir }], engine, store, () => {});
	const message = { id: 1, content: { sender: 'user', kind: 'text', text: 'hi' } } as unknown as ActorTaskMessage;
	host.client = {
		request: async (type: string) => (type === 'getActorTask' ? { mode: 'plan', model: null, effort: null } : [message]),
	} as unknown as Client;
	return { host, said, stopped, store };
}

const start = (extra = {}): ClientCall => ({ kind: 'startActorTask', actor: 'a', task_id: 1, prompt: 'go', title: null, mode: 'plan', model: null, effort: null, ...extra });
const text = (text: string): ActorUserContent => ({ kind: 'text', text });

test('a started task is stored, opened and told its prompt', async () => {
	const { host, said, store } = setup();
	expect(await host.onCall(start())).toEqual({ kind: 'accepted' });
	expect(said).toEqual(['say:go']);
	expect(store.get(1)?.mode).toBe('plan');
	expect(host.running).toEqual([{ id: 1, status: 'idle' }]);
});

test('a message to a task kept on disk opens it; to a running one goes straight', async () => {
	const { host, said } = setup({ actor: 'a', model: null, effort: null, mode: 'default' });
	const message = (t: string): ClientCall => ({ kind: 'sendActorTaskMessage', actor: 'a', task_id: 1, message_id: 1, content: text(t) });
	await host.onCall(message('one'));
	await host.onCall(message('two'));
	expect(said).toEqual(['hear:one', 'hear:two']);
});

test('a task the client never had is picked up from the transcript', async () => {
	const { host, said, store } = setup();
	await host.onCall({ kind: 'sendActorTaskMessage', actor: 'a', task_id: 1, message_id: 1, content: text('more') });
	expect(said[0]).toContain('a Bot session that is no longer available');
	expect(said[0]).toContain('User: hi');
	expect(said[0]).toEndWith('more');
	expect(store.get(1)?.titled).toBe('given');
});

test('modes are checked, and kept for a task with no runner', async () => {
	const { host, store } = setup({ actor: 'a', model: null, effort: null, mode: 'default' });
	await host.onCall({ kind: 'setActorTaskMode', actor: 'a', task_id: 1, mode: 'plan' });
	expect(store.get(1)?.mode).toBe('plan');
	await expect(host.onCall({ kind: 'setActorTaskMode', actor: 'a', task_id: 1, mode: 'x' })).rejects.toThrow('no mode x');
});

test('an unknown actor is refused', async () => {
	const { host } = setup();
	await expect(host.onCall(start({ actor: 'zz' }))).rejects.toThrow('no actor zz');
});

test('transcripts and images', () => {
	expect(transcriptText([{ id: 1, content: { sender: 'actor', kind: 'text', text: 'ok' } } as unknown as ActorTaskMessage], 'Bot')).toBe('Bot: ok');
	const good = { media_type: 'image/jpg', data: 'aGk=' };
	expect(sendable([good, { media_type: 'text/plain', data: '' }])).toEqual({ images: [{ media_type: 'image/jpeg', data: 'aGk=' }], dropped: ['it is text/plain'] });
});
