import { expect, test } from 'bun:test';

import type { Actor, ActorTask, ActorTaskStatus } from 'cohesion-ts';

import { dispatchTask, type Requester } from '../index.ts';

function fake(statuses: ActorTaskStatus[], actors: Partial<Actor>[] = [{ id: 5, identifier: 'a', product: 'P', deleted: false }]) {
	const calls: { type: string; args: unknown }[] = [];
	let reads = 0;
	const task = (status: ActorTaskStatus) => ({ id: 9, status }) as ActorTask;
	const client = {
		request: async (type: string, args?: unknown) => {
			calls.push({ type, args });
			if (type === 'listActors') return actors;
			if (type === 'startActorTask') return task('working');
			if (type === 'getActorTask') return task(statuses[Math.min(reads++, statuses.length - 1)]!);
			if (type === 'listActorTaskMessages') return [{ id: 1, content: { sender: 'actor', kind: 'text', text: 'done' } }];
			return task('idle');
		},
	} as unknown as Requester;
	return { client, calls };
}

test('dispatch resolves an actor by identifier, starts the task and waits for it', async () => {
	const { client, calls } = fake(['working', 'idle']);
	const task = await dispatchTask(client, { actor: { identifier: 'a' }, prompt: 'go', mode: 'plan' });
	expect(calls[1]).toEqual({ type: 'startActorTask', args: { actor_id: 5, prompt: 'go', title: null, mode: 'plan', model: null, effort: null, attachments: null } });
	expect((await task.settled({ pollMs: 1 })).status).toBe('idle');
	expect(await task.lastText()).toBe('done');
});

test('waiting times out; an ambiguous or missing actor is refused', async () => {
	const { client } = fake(['working']);
	const task = await dispatchTask(client, { actor: 5, prompt: 'go' });
	await expect(task.settled({ pollMs: 1, timeoutMs: 5 })).rejects.toThrow('still working');
	await expect(dispatchTask(fake([], []).client, { actor: { identifier: 'a' }, prompt: '' })).rejects.toThrow('No actor');
	const two = [{ id: 1, identifier: 'a', deleted: false }, { id: 2, identifier: 'a', deleted: false }];
	await expect(dispatchTask(fake([], two).client, { actor: { identifier: 'a' }, prompt: '' })).rejects.toThrow('2 actors');
});
