# Phase 22 — The Assistant

SandboxOS's whole premise is that the system-call interface is a tool-calling protocol.
Until now that was a claim the architecture made and the user never got to feel. The
Assistant is what the premise looks like from the chair: you say what you want, and the
model reaches for the same MCP tools you would have typed, through the same Kernel, under
*your* capabilities, with every call landing in the audit dock beside the ones you made
yourself.

The transcript is not a description of the work. It **is** the work.

## How it differs from an AI agent

`agents.spawn kind=ai` already ran a tool loop. Three differences make the Assistant a
different thing rather than a nicer wrapper:

- **It streams.** Text and tool calls appear as they happen, not as a stored result after
  the run finishes.
- **It is a conversation.** Turns accumulate and persist, so you can come back to it.
- **It is interruptible.** Closing the tab aborts the turn; so does the stop button.

And one difference in authority: an agent is a *delegation* — it gets its own principal
and an attenuated token. The Assistant is not. It runs as **you**, with your held
patterns, so it can never exceed you and needs no minted token. When it asks for a tool
you do not hold, the Kernel denies it exactly as it would deny you.

## Provider-neutral streaming

`packages/assistant/src/stream.js` reduces two different wire formats to one vocabulary:

```
{ type: "text",       text }          incremental prose
{ type: "tool_start", id, name }      a tool call has begun
{ type: "tool_args",  id, partial }   incremental JSON for that call
{ type: "usage",      input, output } token accounting
{ type: "stop",       reason }        the turn ended
```

Anthropic emits typed content blocks with deltas; OpenAI emits a delta object carrying an
array of partial tool calls, where only the first chunk of each carries its id and name.
Both are normalized here, and nothing above the transport learns which provider it is
talking to. The turn loop, the persistence layer and the UI are written once.

## The turn loop

`runTurn()` is the whole engine. Per step it streams the model's answer, assembles any
tool calls from their JSON fragments, records the assistant turn *in provider shape* (so
the next turn replays correctly), runs each tool through `kernel.call`, feeds the results
back, and repeats until the model stops asking for tools.

It is bounded on three axes, all env-tunable: `MAX_STEPS` round trips,
`SANDBOXOS_ASSISTANT_MAX_MS` of wall clock, and `SANDBOXOS_ASSISTANT_MAX_TOKENS`
summed across steps. A tool result over 20 KB is truncated before it goes back to the
model, so one `cat` of a large file cannot blow the context. A failing tool is reported
to both the model and the UI and the turn continues — a tool failure is not a turn
failure.

The system prompt tells the model the conventions that are actually specific to this
machine: paths are Sandbox-relative, `proc.exec` finishes but `proc.start` supervises,
a service is unreachable until `ports.expose` declares it, secrets are references.

## Conversations

Two new control-DB tables — `conversations` and `conversation_messages` — store turns in
provider shape, keyed by Sandbox *and* principal: someone else's conversation in your
Sandbox is invisible to you. `renderTranscript()` flattens either provider's shape into
the items a UI renders (text, tool_call, tool_result).

Gateway surface, all under the caller's existing grants:

| route | what it does |
|-------|--------------|
| `GET/POST /:slug/chats` | list and start conversations |
| `GET/PATCH/DELETE /:slug/chats/:id` | transcript, rename, delete |
| `POST /:slug/chats/:id/send` | run one turn, streaming events over SSE |

An untitled conversation takes its name from its first message. Closing the connection
aborts the turn rather than leaving a tool loop running against the machine.

## The workspace

A conversation list, a stream, and a composer. Assistant prose streams into a paragraph;
a tool call interrupts it with a card showing the tool name, its arguments, a spinner,
and then the result — green for ok, red for an error. Prose after a tool call starts a
new paragraph, which is what makes a multi-step run readable. A transcript reloaded
mid-turn marks its unfinished cards "interrupted" rather than spinning forever.

⌘K offers any free-form text three ways now: run it as a command, translate it to one, or
hand it to the assistant.

## Tests

`test/phase22.test.js` — 20 tests. The turn loop is exercised against
`test/fixtures/stub-provider.js`, a stand-in that speaks both providers' streaming wire
formats and replays scripted turns, so the loop is tested deterministically and offline:
text really arrives in deltas, a tool call really writes a file and really appears in the
audit log, several calls in one step all run in order, a denied tool is denied even
though the model asked, the step budget stops a runaway loop, an abort stops the turn,
and a missing key produces a sentence rather than a stack trace. The same coverage runs
against the OpenAI format, including that the stored turn keeps OpenAI's shape.

The workspace was then driven in a real browser against a stub provider: ask, watch the
prose stream and the `fs.write` card fill in, reload, see the transcript replay, and find
the file the assistant wrote sitting in the file tree. Full suite: 414 passing.
