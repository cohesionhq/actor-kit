# cohesion-agent-kit

What Cohesion actor clients share, on top of [cohesion-ts](../cohesion-ts):
`cohesion-claude-code` and `cohesion-opencode` each carried their own copy of
the config, pairing, command line, call routing and run loop. This is that
code once. It adds no protocol: frames, requests and `PROTOCOL_VERSION` stay
in cohesion-ts, and the agent itself (sessions, tools, translating its events
into transcript messages) stays in the client.

Depend on it like both clients depend on cohesion-ts, from the checkout next
to theirs: `"cohesion-agent-kit": "file:../cohesion-agent-kit"`. For Bun only.

## API

Everything is exported from `index.ts`.

**Configuration and registration** (`config.ts`, `setup.ts`)

- `AppInfo { name, product, configEnv? }`: the command name (and config
  directory), and the agent's product name.
- `defaultConfigDirectory(app)`, `loadConfig(app, dir)`, `saveConfig(dir, config)`,
  `hasConfig`, `writeOwnerOnly`. `Config<A> = { server, actors: A[] }`, where
  `A extends ActorEntry { identifier, directory }`; extend `A` for more per actor.
- `withActor(config, actor)`, `withoutActor(config, identifier)`.
- `setupLocal(app, dir, { socket?, name? })` and
  `setupPaired(app, dir, setupCode, { name? })` register with cohesiond (a
  local key, or a one-time setup code and mutual TLS) and keep `server` in the
  config, leaving the actors alone. They return the line to tell the user.

**Command line** (`cli.ts`)

- `runCli({ app, run(directory) }, argv?, io?)` gives `setup`, `add`,
  `remove`, `list` and `run`, and returns the exit code. The client supplies
  only `run`.

**Run loop** (`service.ts`)

- `ActorService.create({ app, directory, config, host, offers, afterOffer?, log })`
  builds the `Client` with `offers(config)` as its `hello`, wires `host.onCall`
  and `host.onConnect`, sets `host.client`, and logs online/offline/evicted.
  `run()` serves until SIGINT/SIGTERM or eviction, and re-offers whenever
  `config.json` changes. `service.client` is the cohesion-ts `Client`
  (`usage`, `report`, `request`).

**Task dispatch and durable state, actor side** (`host.ts`, `task_store.ts`)

- `TaskHost<R, A>` answers cohesiond's calls: `startActorTask`,
  `sendActorTaskMessage`, `stopActorTask`, `setActorTaskMode`. It keeps one
  `TaskRunner` per task, picks a task up from disk after a restart, or from
  cohesiond's transcript when the client never had it, and resyncs running
  tasks on every new session. `host.running` reads back each task's status;
  `host.task(id)` and `host.adopt(id)` reach a runner.
- You supply a `TaskEngine<R, A>` (how to make a record, check a mode, open a
  runner) and a `TaskRunner` per task (`say`, `hear`, `stop`, `setMode`,
  `resync`, `status`). The engine is the only agent-specific code.
- `TaskStore<R extends TaskRecordBase>` is the durable context: `tasks.json`
  in the config directory, owner-only, keyed by Cohesion's task id. The base
  record has `actor`, `model`, `effort`, `titled`, `title`; add the session id
  and mode in your own `R`.

**Dispatch, caller side** (`dispatch.ts`)

- `dispatchTask(client, { actor, prompt, title?, mode?, model?, effort?, images? })`
  starts a task on an actor (by id, or by identifier) and returns a
  `DispatchedTask`: `task`/`status` (last read), `refresh()`, `messages()`,
  `lastText()`, `say()`, `stop()`, and `settled({ pollMs, timeoutMs, until })`
  to wait until it stops working. It works with a `Client` or a `Session`.

**Helpers**: `sendable(images)` (cohesiond's image rules), `describe(content)`,
`transcriptText(messages, speaker, toolName?)`, `stderrLog()`.

```ts
const app = { name: 'cohesion-demo', product: 'Demo' };
process.exit(await runCli({ app, run: async (directory) => {
	const config = loadConfig<ActorEntry>(app, directory);
	const host = new TaskHost(config.actors, engine, new TaskStore(directory), log);
	const service = await ActorService.create({ app, directory, config, host, log,
		offers: (c) => ({ actors: c.actors.map(definition) }) });
	await service.run();
} }));
```

## Design

- **Wrap, don't invent.** Each module is what both clients already had,
  identical up to product names: `config`, `task_store` (generic over the
  record), `images`, the transcript text, `index.ts`'s commands, and
  `host.ts`'s routing. Where they differed (the mode field, the recovered
  title, an async or sync `say`), the difference is a `TaskEngine` method.
- **Durable context means the task record.** What must survive a restart is
  the map from Cohesion's task id to the agent's session and settings;
  `TaskStore` plus `TaskHost` is that. The transcript and status are
  cohesiond's, which `dispatch.ts` reads back. The kit keeps no second copy.
- **No fallbacks for older clients or daemons**: it targets protocol 4 only.

## Left out on purpose

Translating an agent's events to transcript kinds; permission, question and
plan requests (`translate.ts`/`task.ts` in each client); title, context and
usage reporting; the agent's mode and model offers; install scripts and
systemd units; protocol, connection and reconnect logic (cohesion-ts has them).

## Checks

```sh
bun install
bun run check
bun test
```
