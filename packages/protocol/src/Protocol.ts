/**
 * The wire contract between `pim-server` and its remote clients.
 *
 * Imported by **server and web only** — the TUI keeps its in-process
 * `createAgentSession()`, so nothing here may assume a
 * browser, a DOM, or a transport. These are types plus two constants — the
 * version and the close code that refuses it — so a bundler can tree-shake
 * the rest away.
 */

/**
 * Bumped on any breaking change to `Command` / `ServerEvent`. The client sends
 * it in the `attach` handshake; a server that does not recognise it refuses the
 * connection rather than mis-parsing a newer frame. Versioned from day one so
 * the first incompatible change is a rejection, not a silent field mismatch.
 *
 * 11 — a client can read one subagent's transcript, live, with
 * `watch_subagent` / `unwatch_subagent`; its events arrive enveloped in
 * `subagent_events` so they can never be mistaken for the parent's. A watch
 * is read-only and is not an attach: the connection stays attached to the
 * one session it was, and the child is named by the parent's tool call id,
 * from which the server derives the log. Breaking because a server that
 * predates it would answer a watch with "unknown command" — and because a
 * client that predates it cannot be handed one either.
 *
 * 10 — a client can ask the machine for the latest code: `reload` updates this
 * install and restarts it whether or not the update moved anything, because
 * the operator is asking to run the new version rather than asking whether
 * there is one. `update_state` reports that run to every connection, not
 * only the one that asked, since the restart at the end of it takes them all
 * down together; and `attached` names the pim and pi now running, which is
 * what a client that comes back needs to say what it came back to.
 *
 * 9 — a listed session carries `settledAt`, when its agent last stopped, in
 * place of `modifiedAt`: the catalogue orders and ages its rows on the end
 * of the last completed turn, which a user message does not move. It also
 * says whether it is `unread`, and `session_read` says that one has been
 * read; the mark lives on the server, one cursor per session rather than one
 * per client, so `head` is gone from a listing — it was there for a client
 * to answer that question for itself.
 *
 * 8 — `session_activity` says that some session's agent started or stopped
 * working, and reaches every client rather than only the one attached to it;
 * a listed session carries the same `status` when this server is running it.
 *
 * 7 — a `user_message` sent into a running turn steers it, so the `steer`
 * command is gone and a steer can carry attachments; `cancel` answers with
 * the queued messages it took back, and `dequeue` takes them back without
 * stopping the turn. Durable messages arrive as pi writes them rather than
 * at the end of the run, and `message_retire` names the live message each
 * one supersedes.
 *
 * 6 — `session_state` reports the git tree as a `dirtyCount` rather than a
 * `dirty` flag, and carries `ahead` / `behind`.
 *
 * 5 — a resume arrives as one `replay` frame carrying the events, rather than
 * as one frame per event.
 *
 * 4 — the approval gate is gone (`approve_tool`, `approval_request`,
 * `approval_resolved` deleted, every tool call now runs unattended); sessions
 * carry a `title` and a `head`; `session_state` carries context usage and the
 * git branch; durable messages carry a `timestamp`; `list_models` answers
 * with the model catalogue and this model's thinking levels.
 */
export const PROTOCOL_VERSION = 11;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * How a server hangs up on a client speaking a version it does not. Lives with
 * the version it is about: the refusal is half of what makes the handshake
 * mean anything, and both sides need the number — one to send it, the other to
 * tell it from a socket that merely dropped and will succeed on the retry.
 */
export const CLOSE_PROTOCOL_MISMATCH = 4001;
