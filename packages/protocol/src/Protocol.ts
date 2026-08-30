/**
 * The wire contract between `pim-server` and its remote clients.
 *
 * Imported by **server and web only** — the TUI keeps its in-process
 * `createAgentSession()` (Resolved Decision 1), so nothing here may assume a
 * browser, a DOM, or a transport. These are types plus one constant; the only
 * value import is the version, so a bundler can tree-shake the rest away.
 */

/**
 * Bumped on any breaking change to `Command` / `ServerEvent`. The client sends
 * it in the `attach` handshake; a server that does not recognise it refuses the
 * connection rather than mis-parsing a newer frame. Versioned from day one so
 * the first incompatible change is a rejection, not a silent field mismatch.
 */
export const PROTOCOL_VERSION = 2;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
