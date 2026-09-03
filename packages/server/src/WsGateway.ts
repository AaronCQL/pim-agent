import type { Server, ServerWebSocket } from "bun";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { AttachmentStore } from "../../core/src/attachments/AttachmentStore";
import type { PickerItem } from "../../core/src/picker/PickerItem";
import type { SessionRegistry } from "../../core/src/session/SessionRegistry";
import type { SessionHost } from "../../core/src/session/SessionHost";
import type { Command } from "../../protocol/src/Command";
import { PROTOCOL_VERSION } from "../../protocol/src/Protocol";
import type { SessionSummaryView } from "../../protocol/src/ServerEvent";
import { ClientConnection } from "./ClientConnection";
import { SessionStream } from "./SessionStream";
import { StaticClient } from "./StaticClient";
import { UploadEndpoint } from "./UploadEndpoint";

/** Close code for a client speaking a protocol this server does not. */
export const CLOSE_PROTOCOL_MISMATCH = 4001;

export type WsGatewayDeps = {
  readonly registry: SessionRegistry;
  /**
   * Loopback by default and never `0.0.0.0`. Phase 6 moves this to the tailnet
   * interface and adds the bearer token; until then the server has full host
   * access with no auth, so it must not be reachable off-box.
   */
  readonly hostname?: string;
  /** 0 asks the OS for a free port; read it back from `port`. */
  readonly port?: number;
  /** Where `POST /upload` materialises bytes; defaults to `~/.pim/attachments`. */
  readonly attachmentsRoot?: string;
  /** The built web client; defaults to the bundle shipped beside this package. */
  readonly clientDir?: string;
};

/** What a command answered with: an error, rows, or neither. */
type Outcome = {
  readonly error?: string;
  readonly items?: readonly PickerItem[];
  readonly sessions?: readonly SessionSummaryView[];
};

/** Enough rows to fill a switcher; the catalogue is read newest-first. */
const DEFAULT_SESSION_LIMIT = 50;

const DEFAULT_PORT = 4319;

/**
 * How long `stop()` waits for open sockets to drain. Bounded because Bun
 * 1.3.14 never releases the `pendingWebSockets` slot of a socket the *server*
 * closed (a rejected handshake), which makes an unbounded `Server.stop(true)`
 * hang forever. The listener is closed either way.
 */
const STOP_GRACE_MS = 250;

/**
 * The transport half of pim-server: a WebSocket endpoint over the session
 * runtime in `core`. It owns no agent state — every session it serves outlives
 * every connection to it, which is the entire point of the split.
 */
export class WsGateway {
  private readonly registry: SessionRegistry;
  private readonly hostname: string;
  private readonly requestedPort: number;
  private readonly uploads: UploadEndpoint;
  private readonly client: StaticClient;
  private readonly streams = new Map<string, SessionStream>();
  private readonly opening = new Map<string, Promise<SessionStream>>();
  private readonly connections = new Map<
    ServerWebSocket<undefined>,
    ClientConnection
  >();
  private server: Server<undefined> | undefined;

  public constructor(deps: WsGatewayDeps) {
    this.registry = deps.registry;
    this.hostname = deps.hostname ?? "127.0.0.1";
    this.requestedPort = deps.port ?? DEFAULT_PORT;
    this.uploads = new UploadEndpoint(
      deps.attachmentsRoot === undefined ? {} : { root: deps.attachmentsRoot }
    );
    this.client = new StaticClient(deps.clientDir);
  }

  public get port(): number {
    const port = this.server?.port;
    if (port === undefined) {
      throw new Error("WsGateway is not listening");
    }
    return port;
  }

  public get url(): string {
    return `ws://${this.hostname}:${this.port}`;
  }

  public start(): void {
    if (this.server) {
      return;
    }
    this.server = Bun.serve({
      hostname: this.hostname,
      port: this.requestedPort,
      idleTimeout: 0,
      fetch: (req, server) => {
        const { pathname } = new URL(req.url);
        if (pathname === "/health") {
          return Response.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
        }
        if (pathname === "/upload") {
          return this.uploads.handle(req);
        }
        // Upgrade is tried first so the socket keeps answering on every path,
        // exactly as it did before the client was served alongside it.
        return server.upgrade(req) ? undefined : this.client.handle(req);
      },
      websocket: {
        backpressureLimit: 8 << 20,
        closeOnBackpressureLimit: false,
        open: (ws) => {
          this.connections.set(ws, new ClientConnection(ws));
        },
        message: (ws, raw) => {
          void this.onMessage(ws, raw);
        },
        drain: (ws) => {
          this.connections.get(ws)?.onDrain();
        },
        close: (ws) => {
          this.connections.get(ws)?.close();
          this.connections.delete(ws);
        },
      },
    });
  }

  public async stop(): Promise<void> {
    for (const stream of this.streams.values()) {
      stream.dispose();
    }
    this.streams.clear();
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await Promise.race([server.stop(true), Bun.sleep(STOP_GRACE_MS)]);
    }
  }

  private async onMessage(
    ws: ServerWebSocket<undefined>,
    raw: string | Buffer
  ): Promise<void> {
    const connection = this.connections.get(ws);
    if (!connection) {
      return;
    }
    let command: Command;
    try {
      command = JSON.parse(String(raw)) as Command;
    } catch {
      connection.send({ type: "error", message: "malformed frame" });
      return;
    }
    if (typeof command?.id !== "string" || typeof command?.type !== "string") {
      connection.send({ type: "error", message: "frame is not a command" });
      return;
    }
    if (
      command.type === "attach" &&
      command.protocolVersion !== PROTOCOL_VERSION
    ) {
      connection.send({
        type: "response",
        id: command.id,
        success: false,
        error: `unsupported protocol version ${String(command.protocolVersion)}; this server speaks ${PROTOCOL_VERSION}`,
      });
      ws.close(CLOSE_PROTOCOL_MISMATCH, "protocol version mismatch");
      return;
    }
    try {
      const { error, items, sessions } = await this.dispatch(
        connection,
        command
      );
      connection.send({
        type: "response",
        id: command.id,
        success: error === undefined,
        ...(error === undefined ? {} : { error }),
        ...(items === undefined ? {} : { items }),
        ...(sessions === undefined ? {} : { sessions }),
      });
    } catch (err) {
      connection.send({
        type: "response",
        id: command.id,
        success: false,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  private async dispatch(
    connection: ClientConnection,
    command: Command
  ): Promise<Outcome> {
    if (command.type === "attach") {
      return await this.attach(connection, command);
    }
    // The catalogue is what a client reads *before* it has a session, so it is
    // the one command that answers without one.
    if (command.type === "list_sessions") {
      return { sessions: await this.listSessions(command) };
    }
    const stream = connection.sessionId
      ? this.streams.get(connection.sessionId)
      : undefined;
    if (!stream) {
      return { error: "not attached: send `attach` first" };
    }
    const host = stream.host;
    switch (command.type) {
      case "user_message":
        this.promptWithAttachments(stream, command);
        return {};
      case "steer":
        this.prompt(host, command.text, "steer");
        return {};
      case "cancel":
        return (await host.cancel()) ? {} : { error: "nothing to cancel" };
      case "set_cwd": {
        const result = await host.setCwd(command.value);
        stream.push(stream.sessionState());
        if (!result.ok) {
          return { error: result.error };
        }
        stream.invalidatePickers("all");
        return {};
      }
      case "set_model": {
        const result = await host.setModel(command.value);
        stream.push(stream.sessionState());
        return result.ok
          ? {}
          : {
              error: `${result.kind} model "${command.value}"; candidates: ${result.candidates.join(", ")}`,
            };
      }
      case "set_thinking":
        await host.setThinkingLevel(command.value as ThinkingLevel);
        stream.push(stream.sessionState());
        return {};
      case "approve_tool": {
        const result = stream.resolveApproval(command.callId, command.approved);
        return result.ok ? {} : { error: result.error };
      }
      case "pick_files":
        return {
          items: await stream.picker.files(command.query, command.limit),
        };
      case "pick_commands":
        return { items: stream.picker.commands(command.query, command.limit) };
      default:
        return { error: `unknown command: ${(command as Command).type}` };
    }
  }

  private async attach(
    connection: ClientConnection,
    command: Command & { readonly type: "attach" }
  ): Promise<Outcome> {
    const stream = await this.ensureStream(command.sessionId, command.cwd);
    connection.send({
      type: "attached",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: stream.sessionId,
      cwd: stream.host.cwd,
      head: await stream.refresh(),
    });
    await connection.attach(stream, command.fromSeq);
    return {};
  }

  private async listSessions(
    command: Command & { readonly type: "list_sessions" }
  ): Promise<readonly SessionSummaryView[]> {
    const summaries = await this.registry.list(command.cwd);
    return summaries
      .slice(0, command.limit ?? DEFAULT_SESSION_LIMIT)
      .map(({ sessionId, cwd, createdAt, modifiedAt }) => ({
        sessionId,
        cwd,
        createdAt,
        modifiedAt,
      }));
  }

  private async ensureStream(
    sessionId: string | undefined,
    cwd: string | undefined
  ): Promise<SessionStream> {
    if (sessionId) {
      const live = this.streams.get(sessionId);
      if (live) {
        return live;
      }
      const pending = this.opening.get(sessionId);
      if (pending) {
        return await pending;
      }
    }
    const build = this.buildStream(sessionId, cwd);
    if (sessionId) {
      this.opening.set(sessionId, build);
    }
    try {
      return await build;
    } finally {
      if (sessionId) {
        this.opening.delete(sessionId);
      }
    }
  }

  private async buildStream(
    sessionId: string | undefined,
    cwd: string | undefined
  ): Promise<SessionStream> {
    const host = sessionId
      ? await this.registry.open(sessionId)
      : await this.registry.create(cwd);
    // Pi assigns the id and the file, and only does so once an agent exists.
    await host.run(async () => {});
    const agent = host.agentSession;
    const id = host.sessionId;
    const path = agent?.sessionFile ?? host.settings.sessionPath;
    if (!agent || !id || !path) {
      throw new Error(`session ${sessionId ?? "(new)"} has no agent`);
    }
    const existing = this.streams.get(id);
    if (existing) {
      return existing;
    }
    const stream = new SessionStream(id, host, path);
    stream.start(agent);
    this.streams.set(id, stream);
    return stream;
  }

  /**
   * Resolves the ids `POST /upload` handed out into what the agent is told:
   * inline bytes for an image, a server path for anything else. The client's
   * own path for those bytes was never sent and never enters the history.
   */
  private promptWithAttachments(
    stream: SessionStream,
    command: Command & { readonly type: "user_message" }
  ): void {
    const taken = this.uploads.take(
      stream.sessionId,
      (command.attachments ?? []).map((ref) => ref.id)
    );
    const { lines, images } = AttachmentStore.toPrompt(taken);
    const text = [command.text, ...lines].filter(Boolean).join("\n\n").trim();
    this.prompt(stream.host, text, "followUp", images);
  }

  /**
   * Turns are fire-and-forget: the response says the prompt was accepted, not
   * that the agent finished. Waiting would tie the turn to the connection,
   * which is exactly what this architecture exists to avoid.
   */
  private prompt(
    host: SessionHost,
    text: string,
    streamingBehavior: "steer" | "followUp",
    images: readonly ImageContent[] = []
  ): void {
    const attached = images.length === 0 ? {} : { images: [...images] };
    const agent = host.agentSession;
    if (agent && host.isStreaming) {
      void agent
        .prompt(text, { streamingBehavior, source: "rpc", ...attached })
        .catch((err: unknown) => {
          console.error(`[gateway] ${streamingBehavior} failed:`, err);
        });
      return;
    }
    void host
      .run(async (session) => {
        await session.prompt(text, { source: "rpc", ...attached });
      })
      .catch((err: unknown) => {
        console.error(`[gateway] turn failed:`, err);
      });
  }
}
