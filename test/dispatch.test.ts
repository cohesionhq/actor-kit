import { expect, test } from 'bun:test';

import type { Actor, ActorSession, ActorSessionStatus } from 'cohesion-ts';

import { dispatchSession, type Requester } from '../index.ts';

function fake(statuses: ActorSessionStatus[], actors: Partial<Actor>[] = [{ id: 5, identifier: 'a', product: 'P', deleted: false }]) {
	const calls: { type: string; args: unknown }[] = [];
	let reads = 0;
	const session = (status: ActorSessionStatus) => ({ id: 9, status }) as ActorSession;
	const client = {
		request: async (type: string, args?: unknown) => {
			calls.push({ type, args });
			if (type === 'listActors') return actors;
			if (type === 'startActorSession') return session('working');
			if (type === 'getActorSession') return session(statuses[Math.min(reads++, statuses.length - 1)]!);
			if (type === 'listActorSessionMessages') return [{ id: 1, content: { sender: 'actor', kind: 'text', text: 'done' } }];
			return session('idle');
		},
	} as unknown as Requester;
	return { client, calls };
}

test('dispatch resolves an actor by identifier, starts the actor session and waits for it', async () => {
	const { client, calls } = fake(['working', 'idle']);
	const session = await dispatchSession(client, { actor: { identifier: 'a' }, prompt: 'go', mode: 'plan' });
	expect(calls[1]).toEqual({ type: 'startActorSession', args: { actor_id: 5, prompt: 'go', title: null, mode: 'plan', model: null, effort: null, attachments: null } });
	expect((await session.settled({ pollMs: 1 })).status).toBe('idle');
	expect(await session.lastText()).toBe('done');
});

test('waiting times out; an ambiguous or missing actor is refused', async () => {
	const { client } = fake(['working']);
	const session = await dispatchSession(client, { actor: 5, prompt: 'go' });
	await expect(session.settled({ pollMs: 1, timeoutMs: 5 })).rejects.toThrow('still working');
	await expect(dispatchSession(fake([], []).client, { actor: { identifier: 'a' }, prompt: '' })).rejects.toThrow('No actor');
	const two = [{ id: 1, identifier: 'a', deleted: false }, { id: 2, identifier: 'a', deleted: false }];
	await expect(dispatchSession(fake([], two).client, { actor: { identifier: 'a' }, prompt: '' })).rejects.toThrow('2 actors');
});
