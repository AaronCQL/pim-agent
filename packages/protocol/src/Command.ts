import type { ProtocolVersion } from "./Protocol";

/**
 * An image the client has already transferred into the server's world via
 * `/upload`. Never a client-local path: the agent has exactly one filesystem
 * and it is the server's (Guiding Decision 8).
 */
export type ImageRef = {
  readonly id: string;
  readonly mimeType: string;
};

/** Client → server. Every command carries an `id` so its response correlates. */
export type Command =
  | {
      readonly id: string;
      readonly type: "attach";
      readonly protocolVersion: ProtocolVersion;
      readonly sessionId: string;
      readonly fromSeq: number;
    }
  | {
      readonly id: string;
      readonly type: "user_message";
      readonly sessionId: string;
      readonly text: string;
      readonly images?: readonly ImageRef[];
    }
  | {
      readonly id: string;
      readonly type: "steer";
      readonly sessionId: string;
      readonly text: string;
    }
  | { readonly id: string; readonly type: "cancel"; readonly sessionId: string }
  | {
      readonly id: string;
      readonly type: "approve_tool";
      readonly sessionId: string;
      readonly callId: string;
      readonly approved: boolean;
    }
  | {
      readonly id: string;
      readonly type: "pick_files";
      readonly sessionId: string;
      readonly query: string;
      readonly limit: number;
    }
  | {
      readonly id: string;
      readonly type: "pick_commands";
      readonly sessionId: string;
      readonly query: string;
    }
  | {
      readonly id: string;
      readonly type: "set_cwd" | "set_model" | "set_thinking";
      readonly sessionId: string;
      readonly value: string;
    };

export type CommandType = Command["type"];
