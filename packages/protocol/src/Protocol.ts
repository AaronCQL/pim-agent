/**
 * The wire contract between `pim-server` and its remote clients.
 *
 * Imported by **server and web only** — the TUI keeps its in-process
 * `createAgentSession()`, so nothing here may assume a
 * browser, a DOM, or a transport. These are types plus two constants — the
 * version and the close code that refuses it — so a bundler can tree-shake
 * the rest away.
 */

export const PROTOCOL_VERSION = 1;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * How a server hangs up on a client speaking a version it does not. Lives with
 * the version it is about: the refusal is half of what makes the handshake
 * mean anything, and both sides need the number — one to send it, the other to
 * tell it from a socket that merely dropped and will succeed on the retry.
 */
export const CLOSE_PROTOCOL_MISMATCH = 4001;
