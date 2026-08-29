# Phase 23 — Access, Tokens and the Audit Log

The capability model has been able to answer "who can touch this machine, and to do
what" since Phase 0. Nothing ever asked it. Phase 23 makes access, delegation and the
audit log into surfaces you can look at and act on — the parts of the security model that
are worth nothing if only the database can see them.

## Access

`listSandboxAccess()` joins grants to principals and returns one row per principal with
the patterns they hold, when they got them, and whether they have a live credential.
Machine principals — minted tokens, agent delegations — appear alongside humans, because
to the Kernel they are the same kind of thing.

**Sharing** obeys the rule that already governs token minting and agent spawning: you
cannot give away what you do not hold. `shareSandbox()` attenuates every requested
pattern against the sharer's own grants and refuses the rest by name. It is idempotent —
re-sharing a pattern someone already holds adds nothing.

**Revoking** takes the credential with it. A machine principal exists only for its token,
so dropping its last grant destroys its sessions too; leaving one alive would leave a
bearer token that authenticates to a principal with no rights, which is confusing at best.
A human keeps their login and simply loses this Sandbox.

| route | |
|---|---|
| `GET /:slug/access` | who can reach this machine, and as what |
| `POST /:slug/access` | share with an account, attenuated |
| `DELETE /:slug/access/:principalId` | revoke (you cannot revoke yourself) |
| `GET /:slug/tokens` | machine tokens with their patterns and expiry |
| `DELETE /:slug/tokens/:principalId` | revoke a token and its credential |

## The audit log, as a thing you can use

The dock tails the log live. This phase adds the other half — going *through* it.

The **audit explorer** lives in the Observability workspace behind a segmented control
(Overview / Audit log): filter by server, tool and result kind, page forward through the
log with the cursor the `/audit` endpoint already returned, and read each event's
capability and redacted arguments.

**Export** takes it with you: `GET /:slug/audit/export?format=json|csv` honours the same
filters and sets a download filename. CSV quotes every field, because tool arguments
contain commas.

**Chain verification** is operator-only, and the reason is worth stating: the hash chain
links every Sandbox's events into one sequence, so a per-tenant answer would not be
meaningful. `GET /api/admin/audit/verify` walks the whole chain and reports the first row
that breaks it. When the caller is an operator, the explorer offers the check inline and
shows the verdict as a chip.

## Marketplace servers, from the UI

Settings' MCP-server panel now distinguishes built-ins from marketplace installs, and can
install and uninstall them. The dialog says what actually happens: a marketplace server
runs in its own process with no handle to the control plane, and its tools still go
through the Kernel, so they are authorized and audited like any other.

## Notes

The seed owner is the host operator, which is easy to forget when writing a test that
asserts an operator route is refused — the denial has to be checked as somebody else. And
`/login` resolves a primary Sandbox, so an account created straight through
`createAccount()` cannot log in until its tenant has one.

## Tests

`test/phase23.test.js` — 20 tests: access listing, attenuated sharing (including that a
narrow holder cannot widen, that a stranger cannot share at all, and that re-sharing is a
no-op), revocation destroying the credential and not the account, token listing and
revocation making a live bearer token stop authenticating, the Gateway routes for all of
it, JSON and CSV export honouring filters, and chain verification being operator-only.

Driven in a browser too: sign up a second account, share the Sandbox with it, watch the
row appear with its patterns, mint a token and see it listed, then open the audit log,
filter it, and verify the chain. Full suite: 434 passing.
