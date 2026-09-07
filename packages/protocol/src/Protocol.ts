/**
 * The wire contract between `pim-server` and its remote clients.
 *
 * Imported by **server and web only** — the TUI keeps its in-process
 * `createAgentSession()`, so nothing here may assume a
 * browser, a DOM, or a transport. These are types plus one constant; the only
 * value import is the version, so a bundler can tree-shake the rest away.
 */

/**
 * Bumped on any breaking change to `Command` / `ServerEvent`. The client sends
 * it in the `attach` handshake; a server that does not recognise it refuses the
 * connection rather than mis-parsing a newer frame. Versioned from day one so
 * the first incompatible change is a rejection, not a silent field mismatch.
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
export const PROTOCOL_VERSION = 8;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
