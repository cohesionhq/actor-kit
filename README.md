# cohesion-agent-kit

Build a [Cohesion](https://github.com/cohesionhq/cohesion) actor client
without rewriting the parts every client needs.

A Cohesion *actor* is a coding agent that cohesiond hands tasks to. The
client that offers it has to pair with the daemon, keep a connection up, keep
a config on disk, route four kinds of call to the right task, survive its own
restarts, and ship a command line. None of that depends on which agent it is.
This kit is that part; you write the agent.

```
cohesiond  ◄── cohesion-ts (protocol, connection) ◄── cohesion-agent-kit ◄── your client
                                                        config · pairing · CLI
                                                        call routing · task store · run loop
                                                                              ▲
                                                           you: run the agent, report what it does
```

The kit adds no protocol. Frames, requests and the protocol version live in
[cohesion-ts](../cohesion-ts); the rules for what an actor reports live in
cohesion's `docs/actors.md`. The kit is Bun-only TypeScript and targets the
current protocol only.

It is used by `cohesion-claude-code` and `cohesion-opencode`.

## Contents

- [Install](#install)
- [Quick start: a client in one file](#quick-start-a-client-in-one-file)
- [What you implement](#what-you-implement)
- [What the kit does for you](#what-the-kit-does-for-you)
- [What the config directory holds](#what-the-config-directory-holds)
- [Starting tasks from code](#starting-tasks-from-code)
- [API reference](#api-reference)
- [Testing your client](#testing-your-client)
- [Not included](#not-included)
- [Design](#design)

## Install

The kit is a private repo, consumed the way the clients consume `cohesion-ts`:
from a sibling checkout.

```jsonc
// package.json
"dependencies": {
	"cohesion-agent-kit": "file:../cohesion-agent-kit",
	"cohesion-ts": "file:../cohesion-ts"
}
```

Use the same `tsconfig.json` as `cohesion-ts` (`moduleResolution: bundler`,
`allowImportingTsExtensions`): the packages ship TypeScript source.

The kit re-exports the `cohesion-ts` types a client names most (`Client`,
`ClientCall`, `ActorTaskReport`, `ActorUserContent`, `ClientImage`, …), so one
import is usually enough. For the rest, import from `cohesion-ts`.

## Quick start: a client in one file

[`examples/echo/index.ts`](examples/echo/index.ts) is a complete, type-checked
client whose "agent" repeats what it is told. Everything but `run` works
without a daemon:

```sh
bun examples/echo/index.ts --config /tmp/echo setup --local   # or: setup <setup-code>
bun examples/echo/index.ts --config /tmp/echo add ~/some/project --as demo
bun examples/echo/index.ts --config /tmp/echo list
bun examples/echo/index.ts --config /tmp/echo run             # connects to cohesiond
```

It has five parts, and so will your client.

**1. A record of what must survive a restart.** Extend `TaskRecordBase`
(`actor`, `model`, `effort`, `titled`, `title`) with whatever your agent needs
to pick a task up again: a session id, a mode.

```ts
interface EchoRecord extends TaskRecordBase {
	mode: string;
}
```

**2. A runner per task.** It receives what the user says, drives your agent,
and reports back through `client.report`.

```ts
class EchoTask implements TaskRunner {
	async say(text: string, images: ClientImage[]) {
		const reply = this.record.mode === 'loud' ? text.toUpperCase() : text;
		await this.client.report(this.id, { kind: 'message', content: { kind: 'text', text: reply } });
		await this.client.report(this.id, { kind: 'status', status: 'idle' }); // end every turn with idle
	}
	hear(content, images) { return this.say(describe(content), images); }
	async stop() { /* interrupt the agent */ }
	async setMode(mode: string) { /* change it; persist the record */ }
	async resync(report) { /* after a reconnect, say again what is going on */ }
	// ...
}
```

**3. An engine**, the only other agent-specific code: how to build a record
when a task starts, how to rebuild one for a task you never had, which modes
exist, and how to open a runner for a record.

```ts
const engine: TaskEngine<EchoRecord> = {
	speaker: 'Echo',            // names the agent when a lost transcript is replayed
	session: 'an Echo session', // "This task began in an Echo session that is no longer available"
	start: (actor, call) => ({ actor: actor.identifier, model: call.model, effort: call.effort, mode: /* … */, titled: /* … */ }),
	recover: (actor, held) => ({ /* same, from cohesiond's copy of the task */ }),
	checkMode: (actor, mode) => /* throw if not offered, else return it */,
	withMode: (record, mode) => ({ ...record, mode }),
	open: (id, record, actor, client) => new EchoTask(id, record, client, store),
};
```

**4. What to offer.** One `ActorDefinition` per configured directory, with the
modes and models the agent supports.

```ts
const offers = (config: Config) => ({
	actors: config.actors.map(({ identifier, directory }) => ({
		identifier, product: 'Echo', scope: directory, modes: MODES, models: [],
	})),
});
```

**5. The wiring.** `runCli` gives you `setup`, `add`, `remove`, `list` and
`run`; you supply `run`.

```ts
process.exit(await runCli({ app, run: async (directory) => {
	const config = loadConfig<ActorEntry>(app, directory);
	const store = new TaskStore<EchoRecord>(directory);
	const host = new TaskHost(config.actors, engine(store), store, log);
	const service = await ActorService.create({ app, directory, config, host, offers, log });
	await service.run(); // until SIGINT/SIGTERM or eviction
} }));
```

## What you implement

The kit calls you; you report to cohesiond with `client.report(taskId, …)`
(the `client` your engine's `open` receives). Cohesion's actor rules are in
`docs/actors.md`; the ones a runner most often gets wrong:

| When | Report |
| --- | --- |
| The user speaks | Nothing: cohesiond marks the task `working` itself. |
| The agent says or does something | A `message` (text, `toolUse`, `question`, `permission`, `plan`). A tool's result arrives later as an `end` naming the `toolUse` message. |
| The agent needs the user (a question, a permission, a plan) | The request as a `message`, then `needsAttention`. The user's answer reaches `runner.hear`. |
| A turn ends | `idle`. Always. |
| The agent itself breaks | `failed`. Not for a refused tool or a stopped task. |
| Stop | `runner.stop()`: interrupt the agent and set your state idle. cohesiond sets the status. |
| A reconnect | `runner.resync(report)`: for a task still going on, say its `status` and `progress` again. cohesiond forgot them. |

Optionally report a `title` (only when the record's `titled` is `pending`, so
a title the user gave is never replaced), a `context` (how full the window is)
and, per actor, `client.usage(actor, …)`. `sendable(images)` tidies and checks
images against cohesiond's rules before you attach them to a message, so one
bad image costs the image rather than the message.

`runner.say` and `runner.hear` may be sync or async. For `startActorTask` the
host awaits `say`: if it throws (a model the agent doesn't have), the call
fails and the user sees your message.

## What the kit does for you

- **Pairing and local setup.** `setup <code>` pairs over mutual TLS;
  `setup --local` uses a key for a daemon on this machine. Re-running setup
  keeps the actors already offered.
- **The connection.** One `Client` that reconnects with backoff, offers on every
  session, holds your reports while offline and sends them in order, and stops
  for good when cohesiond evicts the client.
- **Hot reload.** Edit the config (`add`, `remove`) while `run` is going and the
  new offers are sent within a moment; no restart.
- **Call routing.** `startActorTask`, `sendActorTaskMessage`, `stopActorTask`
  and `setActorTaskMode` go to the right runner. Unknown actors and missing
  directories are refused with a message the user sees.
- **Picking tasks back up.** After a restart, a message for a task on disk
  reopens its runner from the stored record. For a task this client never had
  (its disk was lost), the host reads cohesiond's copy of the task and
  transcript, calls `engine.recover`, and hands your agent the transcript as
  context along with the new message.
- **Resync.** On each new session `runner.resync` is called for every runner.

## What the config directory holds

`~/.config/<app.name>`, or the directory in `$COHESION_<NAME>_CONFIG` (for
`cohesion-echo`: `COHESION_ECHO_CONFIG`; override the variable with
`AppInfo.configEnv`), or `--config <dir>`. Files are written 0600 in a 0700
directory: they hold the client's key.

| File | Owner | Contents |
| --- | --- | --- |
| `config.json` | `Config<A>` | `server` (how to reach and identify to cohesiond) and `actors` |
| `tasks.json` | `TaskStore<R>` | Your records by Cohesion task id |

`TaskStore` is the only durable state the kit keeps. Status and transcript
are cohesiond's; read them back with `getActorTask` or `dispatchTask`.

To give each actor more than a directory (a default model, say), extend
`ActorEntry`, pass your type as `A` to `loadConfig`, `TaskHost`, `TaskEngine` and
`ActorService`, and read the extra fields in `offers`. `runCli`'s `add` writes only
`identifier` and `directory`.

## Starting tasks from code

The other direction: a script or another client hands an actor a task and reads
its state back.

```ts
import { Session } from 'cohesion-ts';
import { dispatchTask } from 'cohesion-agent-kit';

const session = await Session.open(server);
const task = await dispatchTask(session, { actor: { identifier: 'cohesion', product: 'Claude Code' }, prompt: 'Fix the flaky test', mode: 'plan' });
await task.settled({ timeoutMs: 10 * 60_000 }); // polls until it stops working
console.log(task.status, await task.lastText());
```

`actor` is an id, or an `{ identifier, product? }` that must match exactly one
actor. The actor's client has to be online. A `DispatchedTask` has `task` and
`status` (as last read), `refresh()`, `messages()`, `lastText()`, `say(text)`,
`stop()` and `settled({ pollMs = 1000, timeoutMs, until })`. It takes a
`Client` or a `Session`; nothing is stored locally.

## API reference

Everything is exported from the package root.

**Configuration and registration**

| | |
| --- | --- |
| `AppInfo { name, product, configEnv? }` | Names the command, config directory and product. |
| `ActorEntry { identifier, directory }` | One offered directory; extend it. |
| `Config<A> { server, actors }` | The config file. |
| `defaultConfigDirectory(app)`, `configPath(dir)`, `hasConfig(dir)` | Where it is. |
| `loadConfig(app, dir)`, `saveConfig(dir, config)`, `writeOwnerOnly(path, text)` | Read and write; owner-only. |
| `withActor(config, actor)`, `withoutActor(config, id)` | Pure edits; refuse duplicates and unknowns. |
| `setupLocal(app, dir, { socket?, name? })` | Use the daemon on this machine. Returns the line to print. |
| `setupPaired(app, dir, code, { name? })` | Pair with a daemon elsewhere. Single-use code. |

**Command line**: `runCli({ app, run }, argv?, io?)` returns the exit code.
`usage(app)` is its help text.

**Run loop**: `ActorService.create({ app, directory, config, host, offers, afterOffer?, log })`.
`host` is a `TaskHost` or anything with `client`, `onCall`, `onConnect` and
optionally `setActors`. `service.run()`, `service.reload()` and `service.client`
(the cohesion-ts `Client`: `report`, `usage`, `request`, `offer`). `stderrLog()`
makes a timestamped logger.

**Tasks on the actor side**

| | |
| --- | --- |
| `TaskHost<R, A>(actors, engine, store, log)` | `onCall`, `onConnect`, `setActors`, `running`, `task(id)`, `adopt(id)`. |
| `TaskEngine<R, A>` | `speaker`, `session`, `toolName?`, `start`, `recover`, `checkMode`, `withMode`, `open`. |
| `TaskRunner` | `id`, `status`, `say`, `hear`, `stop`, `setMode`, `resync`. |
| `TaskStore<R>(dir)` | `get`, `put`, `find(predicate)`. |
| `TaskRecordBase` | `actor`, `model`, `effort`, `titled?`, `title?`. |

`host.adopt(taskId)` opens the runner of a stored task that has none: for an
agent that wakes a session after a restart on its own (OpenCode's events, say).

**Helpers**: `sendable(images)`, `tidy`, `refusal`; `describe(userContent)`,
`transcriptText(messages, speaker, toolName?)`.

**Dispatch**: `dispatchTask(client, options)` and `DispatchedTask`, above.

## Testing your client

The runner and engine are plain objects, so test them without a daemon, as
the kit's own tests do (`test/host.test.ts`): build a `TaskHost` with your
engine, a `TaskStore` on a temp directory, set `host.client` to a stub with a
`report`/`request`, and call `host.onCall(...)`. Test what a regression would
quietly break: what your agent's events become, and that a turn always ends in
`idle`. For the connection itself, cohesion-ts's `test/client.test.ts` has a
fake daemon on a Unix socket.

```sh
bun install
bun run check   # tsc, including the example
bun test
```

## Not included

- **Translating your agent's events** into `toolUse`, `question`, `permission` and
  `plan` messages. This is most of a real client, and it is the part that differs.
- Title, context and usage reporting.
- Install scripts and service units.
- Protocol, wire types, TLS and reconnect logic: cohesion-ts.
- Compatibility with older daemons or clients.

## Design

Each piece is what `cohesion-claude-code` and `cohesion-opencode` already had,
identical up to product names. Where they differed (the mode's field name,
whether starting a task is async, a title on recovery), the difference became a
`TaskEngine` method rather than an option. The record is generic so the kit
never has to know what a session is. Anything only one agent needs stays in
that client.
