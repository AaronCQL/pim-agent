import type { Server, ServerWebSocket } from "bun";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { toAttachmentPrompt } from "#core/attachments/AttachmentStore";
import type { PickerItem } from "#core/picker/PickerItem";
import { EventLog } from "#core/session/EventLog";
import type { SessionDigest } from "#core/session/EventLog";
import { ReadCursors } from "#core/session/ReadCursors";
import type { SessionRegistry } from "#core/session/SessionRegistry";
import type { SessionHost } from "#core/session/SessionHost";
import type { Command } from "#protocol/Command";
import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type {
  ModelView,
  ServerEvent,
  SessionStatus,
  SessionSummaryView,
} from "#protocol/ServerEvent";
import { ClientConnection } from "./ClientConnection";
import { SessionStream } from "./SessionStream";
import { StaticClient } from "./StaticClient";
import { UploadEndpoint } from "./UploadEndpoint";

/** Close code for a client speaking a protocol this server does not. */
export const CLOSE_PROTOCOL_MISMATCH = 4001;

export type WsGatewayDeps = {
  readonly registry: SessionRegistry;
  /**
   * Loopback by default and never `0.0.0.0`: the server has full host access
   * with no auth, so it must not be reachable off-box.
   */
  readonly hostname?: string;
  /** 0 asks the OS for a free port; read it back from `port`. */
  readonly port?: number;
  /** Where `POST /upload` materialises bytes; defaults to `~/.pim/attachments`. */
  readonly attachmentsRoot?: string;
  /** Where the read cursors live; defaults to `~/.pim/read.json`. */
  readonly readCursorsPath?: string;
  /** The built web client; defaults to the bundle shipped beside this package. */
  readonly clientDir?: string;
};

/** What a command answered with: an error, rows, or neither. */
type Outcome = {
  readonly error?: string;
  readonly items?: readonly PickerItem[];
  readonly sessions?: readonly SessionSummaryView[];
  readonly models?: readonly ModelView[];
  readonly thinkingLevels?: readonly string[];
  readonly restored?: readonly string[];
};

/** Enough rows to fill a switcher; the catalogue is read newest-first. */
const DEFAULT_SESSION_LIMIT = 50;

const DEFAULT_PORT = 4319;

/** A digest and the file state it was read from; a rewrite moves both. */
type CachedDigest = SessionDigest & { readonly modifiedAt: number };

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
  /**
   * Which sessions have been read, shared by every client: the mark is a
   * property of the machine, so it is kept beside the sessions rather than
   * in whichever browser happened to be reading.
   */
  private readonly cursors: ReadCursors;
  private readonly client: StaticClient;
  private readonly streams = new Map<string, SessionStream>();
  private readonly opening = new Map<string, Promise<SessionStream>>();
  /**
   * Naming a session costs a read of its whole file, and the sidebar re-lists
   * after every turn — so a file that has not been appended to since the last
   * listing is not read again.
   */
  private readonly digests = new Map<string, CachedDigest>();
  /**
   * The status each session was last announced as. Kept because a stream
   * emits its state on every tool call and every message, and a client only
   * needs the edges — a row starts spinning once and stops once.
   */
  private readonly activity = new Map<string, SessionStatus>();
  /**
   * When each session this server runs last settled, as its file read at the
   * time. Held because that reading is only true of an idle session: see
   * `settleTime`.
   */
  private readonly settled = new Map<string, number>();
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
    this.cursors = new ReadCursors(deps.readCursorsPath);
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
    this.activity.clear();
    this.settled.clear();
    // The marks taken during the run are written behind their callers, so a
    // stop is where the last of them lands.
    await this.cursors.flush();
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
      const { error, ...answer } = await this.dispatch(connection, command);
      connection.send({
        type: "response",
        id: command.id,
        success: error === undefined,
        ...(error === undefined ? {} : { error }),
        ...answer,
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
    if (command.type === "list_models") {
      return {
        models: this.registry.models(),
        // The levels belong to the model this connection is on, so a client
        // with no session yet gets the catalogue and nothing else.
        thinkingLevels:
          (connection.sessionId
            ? this.streams.get(connection.sessionId)?.host
                .supportedThinkingLevels
            : undefined) ?? [],
      };
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
      case "cancel": {
        const { cancelled, restored } = await host.cancel();
        return cancelled ? { restored } : { error: "nothing to cancel" };
      }
      case "dequeue":
        return { restored: host.takeBack() };
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
    // Opening a session is reading it, and there is one mark for all of
    // them, so this is also where every other client's dot goes out.
    await this.markRead(stream.sessionId);
    return {};
  }

  private async listSessions(
    command: Command & { readonly type: "list_sessions" }
  ): Promise<readonly SessionSummaryView[]> {
    const summaries = await this.registry.list(command.cwd);
    // Only an unfiltered listing knows every session there is; pruning
    // against one cut to a cwd would forget every other directory. The
    // sessions this server holds open are alive too — a new chat has a mark
    // before it has a file.
    if (command.cwd === undefined) {
      await this.cursors.prune(
        new Set([
          ...summaries.map((summary) => summary.sessionId),
          ...this.streams.keys(),
        ])
      );
    }
    // Only the page about to be sent is digested, so a thousand-session
    // directory is not read to answer for fifty rows.
    //
    // Which is also why the *cut* is by modified time and the *order* is not:
    // a session's settle time is in its digest, so ranking the whole
    // directory by it would mean reading every session on disk to send fifty.
    // A file is never modified before its agent settles, so the two disagree
    // only inside the page, where the sort below has the real answer.
    const page = await Promise.all(
      summaries
        .slice(0, command.limit ?? DEFAULT_SESSION_LIMIT)
        .map(async ({ sessionId, cwd, path, createdAt, modifiedAt }) => {
          const { title, settledAt } = await this.digestOf(path, modifiedAt);
          // Only a session this server holds open has an agent to answer for
          // it; anything else on disk is a file, and a file is never working.
          const status = this.streams.get(sessionId)?.host.status;
          const answeredAt = this.answerTime(sessionId, status, settledAt);
          const unread = await this.cursors.isUnread(sessionId, answeredAt);
          return {
            sessionId,
            cwd,
            createdAt,
            // The last turn known to have finished; failing that whatever the
            // file last had, which is all there is to date a session running
            // its first one by; failing that, when it was made.
            settledAt: answeredAt ?? settledAt ?? createdAt,
            ...(title === undefined ? {} : { title }),
            ...(status === undefined || status === "idle" ? {} : { status }),
            // Off the completed turn alone, so intermediate lines raise no
            // mark: a row goes unread when its turn ends, which is also when
            // it climbs to the top of this list.
            ...(unread ? { unread: true } : {}),
          };
        })
    );
    return page.sort((a, b) => b.settledAt - a.settledAt);
  }

  /**
   * When this session's last *completed* turn ended, and — for an idle one —
   * where that answer is remembered from. Absent when there is no such turn
   * to point at: an agent that has never answered, or one running the first
   * turn this server has seen of it.
   *
   * The file's answer is the last thing the agent wrote, which is where it
   * stopped only while nothing is running: mid-turn it is the message or
   * tool result that just landed, and a row would climb to the top of the
   * list — and go unread — on every one of them. So a running session is
   * answered for out of what its file said while it was last idle, and the
   * file takes over again the moment the turn ends.
   *
   * A session another process is driving reports no status and is always
   * answered for by its file, drifting while that process writes and correct
   * again as soon as it stops: there is no liveness on disk to do better
   * with, and nothing is remembered for it to be wrong about later.
   */
  private answerTime(
    sessionId: string,
    status: SessionStatus | undefined,
    fromFile: number | undefined
  ): number | undefined {
    if (status === undefined) {
      return fromFile;
    }
    if (status !== "idle") {
      return this.settled.get(sessionId);
    }
    if (fromFile !== undefined) {
      this.settled.set(sessionId, fromFile);
    }
    return fromFile;
  }

  /**
   * Says that a session's agent started or stopped working, to every client
   * on the server, and only on the edges.
   *
   * A turn that ends under a client that is reading it is read, not unread —
   * and the announcement goes first and synchronously, because it is a frame
   * of the session's own stream and every client attached must see it in the
   * same place. The mark trails it by a microtask, which no client can be
   * inside of: the re-list that frame provokes is a whole round trip away.
   */
  private onSessionState(sessionId: string, status: SessionStatus): void {
    if (this.activity.get(sessionId) === status) {
      return;
    }
    this.activity.set(sessionId, status);
    this.broadcast({ type: "session_activity", sessionId, status });
    if (status === "idle" && this.isBeingRead(sessionId)) {
      void this.markRead(sessionId);
    }
  }

  private isBeingRead(sessionId: string): boolean {
    return [...this.connections.values()].some(
      (connection) => connection.sessionId === sessionId
    );
  }

  /**
   * Moves a session's read cursor to now and says so to every client. Said
   * unconditionally, including for a session that was already read: the
   * frame is a few bytes, it is idempotent at every receiver, and the price
   * of skipping it is knowing whether some other client had a dot up.
   */
  private async markRead(sessionId: string): Promise<void> {
    await this.cursors.mark(sessionId);
    this.broadcast({ type: "session_read", sessionId });
  }

  /**
   * To every client on the server, attached to whatever. What travels this
   * way names a session that its receivers are precisely *not* reading:
   * nothing else they are sent says anything about a row they are not in.
   */
  private broadcast(event: ServerEvent): void {
    for (const connection of this.connections.values()) {
      connection.send(event);
    }
  }

  private async digestOf(
    path: string,
    modifiedAt: number
  ): Promise<SessionDigest> {
    const cached = this.digests.get(path);
    if (cached?.modifiedAt === modifiedAt) {
      return cached;
    }
    const digest = await new EventLog(path).digest();
    this.digests.set(path, { ...digest, modifiedAt });
    return digest;
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
    // Pi assigns the id and the file, and only does so once an agent exists;
    // `create` built one already, so only a resumed host pays for it here.
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
    // The gateway listens to every stream it opens, not only to the ones with
    // a client on them: a turn runs to the end with nobody attached, and the
    // session list is drawn from every session at once.
    this.activity.set(id, host.status);
    stream.subscribe((event) => {
      if (event.type === "session_state") {
        this.onSessionState(id, event.status);
      }
    });
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
    const { lines, images } = toAttachmentPrompt(taken);
    const text = [command.text, ...lines].filter(Boolean).join("\n\n").trim();
    this.prompt(stream.host, text, images);
  }

  /**
   * Turns are fire-and-forget: the response says the prompt was accepted, not
   * that the agent finished. Waiting would tie the turn to the connection,
   * which is exactly what this architecture exists to avoid.
   *
   * Said into a turn already running, the message steers it — and it is
   * *merged* with whatever that turn was already holding, so pi is never
   * queueing more than one message at a time. That is what lets a client
   * take the queue back as a single thing, to edit or to abandon: two
   * separately queued messages would need identities on the wire, and pi has
   * no way to remove one of them anyway. It costs the images of a message
   * already queued, which pi gives back as text alone; the words survive.
   */
  private prompt(
    host: SessionHost,
    text: string,
    images: readonly ImageContent[] = []
  ): void {
    const attached = images.length === 0 ? {} : { images: [...images] };
    const agent = host.agentSession;
    if (agent && host.isStreaming) {
      const queued = [...host.takeBack(), text].join("\n\n");
      void agent
        .prompt(queued, {
          streamingBehavior: "steer",
          source: "rpc",
          ...attached,
        })
        .catch((err: unknown) => {
          console.error(`[gateway] steer failed:`, err);
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
