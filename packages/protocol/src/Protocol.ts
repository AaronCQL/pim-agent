export const PROTOCOL_VERSION = 2;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Close code for a client speaking a protocol version the server does not. */
export const CLOSE_PROTOCOL_MISMATCH = 4001;
