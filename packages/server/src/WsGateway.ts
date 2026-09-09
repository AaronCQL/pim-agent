import type { Server, ServerWebSocket } from "bun";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { Attachments } from "#core/attachments/Attachments";
import type { PickerItem } from "#core/picker/PickerItem";
import { Directories } from "#core/shared/Directories";
import type { DirectoryListing } from "#core/shared/Directories";
import { ReadCursors } from "#core/session/ReadCursors";
import type { SessionHost } from "#core/session/SessionHost";
import type { SessionRegistry } from "#core/session/SessionRegistry";
import { PimVersion } from "#core/shared/PimVersion";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import type { UpdateOutcome } from "#core/shared/Updater";
import type { Command } from "#protocol/Command";
import { CLOSE_PROTOCOL_MISMATCH, PROTOCOL_VERSION } from "#protocol/Protocol";
import type {
  ModelView,
  ServerEvent,
  SessionSummaryView,
} from "#protocol/ServerEvent";
import { ClientConnection } from "./ClientConnection";
import { Reloader } from "./Reloader";
import { SessionCatalogue } from "./SessionCatalogue";
import { SessionProjection } from "./SessionProjection";
import { SessionStream } from "./SessionStream";
import { StaticClient } from "./StaticClient";
import { AttachmentEndpoint } from "./AttachmentEndpoint";
import { ImageEndpoint } from "./ImageEndpoint";

export type WsGatewayDeps = {
  readonly registry: SessionRegistry;
  /** Loopback by default and never `0.0.0.0`: full host access, no auth. */
  readonly hostname?: string;
  /** 0 asks the OS for a free port; read it back from `port`. */
  readonly port?: number;
  /** Where uploaded bytes are kept; defaults to `~/.pim/attachments`. */
  readonly attachmentsRoot?: string;
  /** Where `read` spilled the pictures it showed the model; defaults to `~/.pim/cache`. */
  readonly imagesRoot?: string;
  /** Where the read cursors live; defaults to `~/.pim/read.json`. */
  readonly readCursorsPath?: string;
  /** The built web client; defaults to the bundle shipped beside this package. */
  readonly clientDir?: string;
  /** Runs the update a `reload` asks for, reporting each step as it starts. */
  readonly update?: (onStep: (label: string) => void) => Promise<UpdateOutcome>;
  /** Ends this process so the supervisor replaces it with the updated code. */
  readonly shutdown?: () => Promise<void>;
};

type Outcome = {
  readonly error?: string;
  readonly items?: readonly PickerItem[];
  readonly sessions?: readonly SessionSummaryView[];
  readonly models?: readonly ModelView[];
  readonly thinkingLevels?: readonly string[];
  readonly directory?: DirectoryListing;
  readonly restored?: readonly string[];
  readonly after?: () => void;
};

type StreamTarget = {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly like?: SessionHost;
};

export const DEFAULT_PORT = 4319;

export const DEFAULT_HOSTNAME = "127.0.0.1";

// Bun 1.3.14 never frees the slot of a server-closed socket, so an unbounded `Server.stop(true)` hangs.
const STOP_GRACE_MS = 250;

/** The transport half of pim-server: a WebSocket endpoint over the session runtime in `core`. */
export class WsGateway {
  private readonly registry: SessionRegistry;
  private readonly hostname: string;
  private readonly requestedPort: number;
  private readonly uploads: AttachmentEndpoint;
  private readonly images: ImageEndpoint;
  private readonly catalogue: SessionCatalogue;
  private readonly client: StaticClient;
  private readonly streams = new Map<string, SessionStream>();
  private readonly opening = new Map<string, Promise<SessionStream>>();
  private readonly connections = new Map<
    ServerWebSocket<undefined>,
    ClientConnection
  >();
  private readonly reloader: Reloader;
  private versionsRead: Promise<readonly [string, string]> | undefined;
  private server: Server<undefined> | undefined;

  public constructor(deps: WsGatewayDeps) {
    this.registry = deps.registry;
    this.hostname = deps.hostname ?? DEFAULT_HOSTNAME;
    this.requestedPort = deps.port ?? DEFAULT_PORT;
    this.uploads = new AttachmentEndpoint(
      deps.attachmentsRoot === undefined ? {} : { root: deps.attachmentsRoot }
    );
    this.images = new ImageEndpoint(
      deps.imagesRoot === undefined ? {} : { root: deps.imagesRoot }
    );
    this.catalogue = new SessionCatalogue({
      registry: deps.registry,
      cursors: new ReadCursors(deps.readCursorsPath),
      liveStatus: (sessionId) => this.streams.get(sessionId)?.host.status,
      liveSessionIds: () => this.streams.keys(),
      isBeingRead: (sessionId) => this.isBeingRead(sessionId),
      announce: (event) => {
        this.broadcast(event);
      },
    });
    this.client = new StaticClient(deps.clientDir);
    this.reloader = new Reloader({
      announce: (event) => {
        this.broadcast(event);
      },
      update: deps.update,
      shutdown: deps.shutdown,
    });
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
        if (AttachmentEndpoint.owns(pathname)) {
          return this.uploads.handle(req);
        }
        if (ImageEndpoint.owns(pathname)) {
          return this.images.handle(req);
        }
        // Try the upgrade first: the socket must answer on every path.
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
    this.opening.clear();
    this.catalogue.clear();
    await this.catalogue.flush();
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
      const { error, after, ...answer } = await this.dispatch(
        connection,
        command
      );
      connection.send({
        type: "response",
        id: command.id,
        success: error === undefined,
        ...(error === undefined ? {} : { error }),
        ...answer,
      });
      after?.();
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
    switch (command.type) {
      case "attach":
        return await this.attach(connection, command);
      case "list_sessions":
        return { sessions: await this.catalogue.list(command) };
      case "list_models":
        return {
          models: this.registry.models(),
          thinkingLevels:
            this.streamFor(connection)?.host.supportedThinkingLevels ?? [],
        };
      case "list_dirs":
        return { directory: await Directories.list(command.path) };
      case "unwatch_subagent":
        connection.unwatchSubagent(command.callId);
        return {};
      case "reload":
        return this.reload(command.force === true);
      case "user_message":
        this.promptWithAttachments(this.requireStream(connection), command);
        return {};
      case "cancel": {
        const { cancelled, restored } =
          await this.requireStream(connection).host.cancel();
        return cancelled ? { restored } : { error: "nothing to cancel" };
      }
      case "dequeue":
        return { restored: this.requireStream(connection).host.takeBack() };
      case "set_cwd": {
        const stream = this.requireStream(connection);
        const result = await stream.host.setCwd(command.value);
        stream.push(stream.sessionState());
        if (!result.ok) {
          return { error: result.error };
        }
        stream.invalidatePickers("all");
        return {};
      }
      case "set_model": {
        const stream = this.requireStream(connection);
        const result = await stream.host.setModel(command.value);
        stream.push(stream.sessionState());
        return result.ok
          ? {}
          : {
              error: `${result.kind} model "${command.value}"; candidates: ${result.candidates.join(", ")}`,
            };
      }
      case "set_thinking": {
        const stream = this.requireStream(connection);
        await stream.host.setThinkingLevel(command.value as ThinkingLevel);
        stream.push(stream.sessionState());
        return {};
      }
      case "pick_files":
        return {
          items: await this.requireStream(connection).picker.files(
            command.query,
            command.limit
          ),
        };
      case "pick_commands":
        return {
          items: this.requireStream(connection).picker.commands(
            command.query,
            command.limit
          ),
        };
      case "watch_subagent":
        return await this.watchSubagent(
          connection,
          this.requireStream(connection),
          command
        );
      default:
        this.requireStream(connection);
        return { error: `unknown command: ${(command as Command).type}` };
    }
  }

  private streamFor(connection: ClientConnection): SessionStream | undefined {
    const sessionId = connection.sessionId;
    return sessionId ? this.streams.get(sessionId) : undefined;
  }

  private requireStream(connection: ClientConnection): SessionStream {
    const stream = this.streamFor(connection);
    if (!stream) {
      throw new Error("not attached: send `attach` first");
    }
    return stream;
  }

  // Derive the log path from the parent session and call id: a client-sent path reads arbitrary JSONL off this machine.
  private async watchSubagent(
    connection: ClientConnection,
    stream: SessionStream,
    command: Command & { readonly type: "watch_subagent" }
  ): Promise<Outcome> {
    if (command.sessionId !== stream.sessionId) {
      return {
        error: `not attached to session ${command.sessionId}; a watch reads a child of the attached session only`,
      };
    }
    const path = SubagentLogs.pathFor(stream.sessionId, command.callId);
    if (path === null) {
      return { error: `malformed call id: ${command.callId}` };
    }
    if (!(await Bun.file(path).exists())) {
      return { error: `no subagent log for call ${command.callId}` };
    }
    await connection.watchSubagent(
      command.callId,
      new SessionProjection(path, () => stream.host.cwd),
      command.fromSeq
    );
    return {};
  }

  private async attach(
    connection: ClientConnection,
    command: Command & { readonly type: "attach" }
  ): Promise<Outcome> {
    const like =
      command.like === undefined
        ? undefined
        : this.streams.get(command.like)?.host;
    const [stream, [pimVersion, piVersion]] = await Promise.all([
      this.ensureStream({
        ...(command.sessionId === undefined
          ? {}
          : { sessionId: command.sessionId }),
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(like === undefined ? {} : { like }),
      }),
      this.versions(),
    ]);
    connection.send({
      type: "attached",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: stream.sessionId,
      cwd: stream.host.cwd,
      head: await stream.refresh(),
      pimVersion,
      piVersion,
    });
    await connection.attach(stream, command.fromSeq);
    await this.catalogue.markRead(stream.sessionId);
    return {};
  }

  private reload(force: boolean): Outcome {
    const busy = [...this.streams.values()]
      .filter((stream) => stream.host.status !== "idle")
      .map((stream) => stream.sessionId);
    if (!force && busy.length > 0) {
      const many = busy.length > 1;
      return {
        error: `${many ? "sessions" : "session"} ${busy.join(", ")} ${many ? "are" : "is"} mid-turn; reloading would kill ${many ? "those turns" : "that turn"}. Send \`reload\` with \`force\` to do it anyway`,
      };
    }
    return {
      after: () => {
        void this.reloader.start();
      },
    };
  }

  private versions(): Promise<readonly [string, string]> {
    this.versionsRead ??= Promise.all([PimVersion.current(), PimVersion.pi()]);
    return this.versionsRead;
  }

  private isBeingRead(sessionId: string): boolean {
    for (const connection of this.connections.values()) {
      if (connection.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  private broadcast(event: ServerEvent): void {
    for (const connection of this.connections.values()) {
      connection.send(event);
    }
  }

  private async ensureStream(target: StreamTarget): Promise<SessionStream> {
    const sessionId = target.sessionId;
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
    const build = this.buildStream(target);
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

  private async buildStream(target: StreamTarget): Promise<SessionStream> {
    const sessionId = target.sessionId;
    const host = sessionId
      ? await this.registry.open(sessionId)
      : await this.registry.create({
          ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
          ...(target.like === undefined ? {} : { like: target.like }),
        });
    // Pi assigns the id and the session file only once an agent exists.
    const agent = host.agentSession ?? (await host.ensureAgent());
    const id = agent.sessionId;
    const path = agent.sessionFile ?? host.settings.sessionPath;
    if (!path) {
      throw new Error(`session ${sessionId ?? "(new)"} has no agent`);
    }
    const existing = this.streams.get(id);
    if (existing) {
      return existing;
    }
    const stream = new SessionStream(id, host, path);
    stream.start(agent);
    this.catalogue.track(id, host.status);
    stream.subscribe((event) => {
      if (event.type === "session_state") {
        this.catalogue.onStatus(id, event.status);
      }
    });
    this.streams.set(id, stream);
    return stream;
  }

  private promptWithAttachments(
    stream: SessionStream,
    command: Command & { readonly type: "user_message" }
  ): void {
    const taken = this.uploads.take(
      stream.sessionId,
      (command.attachments ?? []).map((ref) => ref.id)
    );
    const { lines, images } = Attachments.render(taken);
    const text = [command.text, ...lines].filter(Boolean).join("\n\n").trim();
    this.prompt(stream, text, images);
  }

  // Merge into the queued message: pi holds at most one, so a second queued send would be unreachable.
  private prompt(
    stream: SessionStream,
    text: string,
    images: readonly ImageContent[] = []
  ): void {
    const attached = images.length === 0 ? {} : { images: [...images] };
    const host = stream.host;
    const agent = host.agentSession;
    const failed = (err: unknown, what: string): void => {
      console.error(`[gateway] ${what} failed:`, err);
      stream.push({
        type: "error",
        message: (err as Error).message || String(err),
      });
    };
    if (agent && host.isStreaming) {
      const queued = [...host.takeBack(), text].join("\n\n");
      void agent
        .prompt(queued, {
          streamingBehavior: "steer",
          source: "rpc",
          ...attached,
        })
        .catch((err: unknown) => {
          failed(err, "steer");
        });
      return;
    }
    void host
      .run(async (session) => {
        await session.prompt(text, { source: "rpc", ...attached });
      })
      .catch((err: unknown) => {
        failed(err, "turn");
      });
  }
}
