import type { Server, ServerWebSocket } from "bun";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { Attachments } from "#core/attachments/Attachments";
import type { PickerItem } from "#core/picker/PickerItem";
import { Directories } from "#core/shared/Directories";
import type { DirectoryListing } from "#core/shared/Directories";
import { EventLog } from "#core/session/EventLog";
import type { SessionDigest } from "#core/session/EventLog";
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
  SessionStatus,
  SessionSummaryView,
} from "#protocol/ServerEvent";
import { ClientConnection } from "./ClientConnection";
import { Reloader } from "./Reloader";
import { SessionProjection } from "./SessionProjection";
import { SessionStream } from "./SessionStream";
import { StaticClient } from "./StaticClient";
import { AttachmentEndpoint } from "./AttachmentEndpoint";

export type WsGatewayDeps = {
  readonly registry: SessionRegistry;
  /**
   * Loopback by default and never `0.0.0.0`: the server has full host access
   * with no auth, so it must not be reachable off-box.
   */
  readonly hostname?: string;
  /** 0 asks the OS for a free port; read it back from `port`. */
  readonly port?: number;
  /** Where uploaded bytes are kept; defaults to `~/.pim/attachments`. */
  readonly attachmentsRoot?: string;
  /** Where the read cursors live; defaults to `~/.pim/read.json`. */
  readonly readCursorsPath?: string;
  /** The built web client; defaults to the bundle shipped beside this package. */
  readonly clientDir?: string;
  /**
   * Runs the update a `reload` asks for, reporting each step as it starts.
   * Defaults to the real one, which spawns installs against this install.
   */
  readonly update?: (onStep: (label: string) => void) => Promise<UpdateOutcome>;
  /**
   * Ends this process so the supervisor replaces it with the updated code.
   * Defaults to restarting the sibling daemons and re-raising `SIGTERM`.
   */
  readonly shutdown?: () => Promise<void>;
};

/** What a command answered with: an error, rows, or neither. */
type Outcome = {
  readonly error?: string;
  readonly items?: readonly PickerItem[];
  readonly sessions?: readonly SessionSummaryView[];
  readonly models?: readonly ModelView[];
  readonly thinkingLevels?: readonly string[];
  readonly directory?: DirectoryListing;
  readonly restored?: readonly string[];
  /**
   * Work that must not run ahead of its own answer. Only `reload` has any:
   * it ends with the socket gone, so a client told "yes" afterwards is a
   * client never told at all.
   */
  readonly after?: () => void;
};

/** Which session a connection is asking for, and what to open a new one like. */
type StreamTarget = {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly like?: SessionHost;
};

/** Enough rows to fill a switcher; the catalogue is read newest-first. */
const DEFAULT_SESSION_LIMIT = 50;

export const DEFAULT_PORT = 4319;

/** Loopback only: the server has full host access and no authentication. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

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
  private readonly uploads: AttachmentEndpoint;
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
  private readonly reloader: Reloader;
  /**
   * Read once and kept: a process cannot change the code it is executing, so
   * a new version is a new process and this cannot go stale under a client.
   */
  private versionsRead: Promise<readonly [string, string]> | undefined;
  private server: Server<undefined> | undefined;

  public constructor(deps: WsGatewayDeps) {
    this.registry = deps.registry;
    this.hostname = deps.hostname ?? DEFAULT_HOSTNAME;
    this.requestedPort = deps.port ?? DEFAULT_PORT;
    this.uploads = new AttachmentEndpoint(
      deps.attachmentsRoot === undefined ? {} : { root: deps.attachmentsRoot }
    );
    this.cursors = new ReadCursors(deps.readCursorsPath);
    this.client = new StaticClient(deps.clientDir);
    this.reloader = new Reloader({
      announce: (event) => {
        this.broadcast(event);
      },
      update: deps.update,
      shutdown: deps.shutdown,
    });
    this.versionsRead = undefined;
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
    if (command.type === "attach") {
      return await this.attach(connection, command);
    }
    // The catalogue is what a client reads *before* it has a session, so it
    // answers without one.
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
    // A fact about the machine's disk, so it answers without a session too:
    // reading where a session could be opened is not opening one, and a
    // reader who browses and then closes the modal has asked for nothing.
    if (command.type === "list_dirs") {
      return { directory: await Directories.list(command.path) };
    }
    // Answered without a session because it is about a watch this connection
    // holds, and a connection that has lost its session has lost that too:
    // closing a modal must never fail.
    if (command.type === "unwatch_subagent") {
      connection.unwatchSubagent(command.callId);
      return {};
    }
    // A fact about the machine, like the two above it: what a reload restarts
    // is the server, so it is answered for a client attached to nothing on it.
    if (command.type === "reload") {
      return this.reload(command.force === true);
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
      case "watch_subagent":
        return await this.watchSubagent(connection, stream, command);
      default:
        return { error: `unknown command: ${(command as Command).type}` };
    }
  }

  /**
   * Opens one subagent's log for reading, on the connection that asked.
   *
   * The path is *derived* from the parent session and the tool call, and is
   * neither sent by the client nor looked up in the parent's log. Not sent,
   * because a path from a client reads arbitrary JSONL off this machine; not
   * looked up, because a run that threw persists no details to look it up in
   * — and a failed subagent is the one most worth reading. What is left to
   * check is that the ids are ids rather than paths, that the parent is the
   * session this connection is actually attached to, and that the file is
   * there.
   */
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
    // Resolved against the streams this server holds rather than looked up on
    // disk: what a new session copies is what another one is *running*, which
    // only a loaded session has. One this server has never opened has no
    // answer to give, so the hint is dropped and the defaults stand.
    const like =
      command.like === undefined
        ? undefined
        : this.streams.get(command.like)?.host;
    const stream = await this.ensureStream({
      ...(command.sessionId === undefined
        ? {}
        : { sessionId: command.sessionId }),
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      ...(like === undefined ? {} : { like }),
    });
    const [pimVersion, piVersion] = await this.versions();
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
    // Opening a session is reading it, and there is one mark for all of
    // them, so this is also where every other client's dot goes out.
    await this.markRead(stream.sessionId);
    return {};
  }

  /**
   * Refused while any session this server holds open is mid-turn: the restart
   * that ends a reload kills whatever those agents are doing, and a turn is
   * not a thing a machine may take back on its own initiative. Only these
   * sessions can be answered for — one a terminal is driving is another
   * process, with nothing but a log file between them — and they are also the
   * only ones a restart here would kill.
   */
  private reload(force: boolean): Outcome {
    const busy = [...this.activity.entries()]
      .filter(([, status]) => status !== "idle")
      .map(([sessionId]) => sessionId);
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
   * to point at: an agent that has never answered, or one whose turn began
   * before any listing had seen it idle.
   *
   * The file's answer is the last thing the agent wrote, which is where it
   * stopped only while nothing is running: mid-turn it is the message or
   * tool result that just landed, and a row would climb to the top of the
   * list — and go unread — on every one of them. So a running session is
   * answered for out of what its file said while it was last idle, and the
   * file takes over again the moment the turn ends.
   *
   * Which makes that freeze best-effort, a listing being the only thing that
   * fills it: a session attached and prompted before anyone listed has
   * nothing remembered, and its row falls back to the file for the length of
   * that turn. Harmless where the sidebar stands, and deliberately not
   * bought with a read on every attach — a running row paints a spinner
   * instead of an age, so the drifting number is never shown, and the unread
   * mark reads the `undefined` this returns rather than the caller's
   * fallback, so it stays down. What is left is a running row sorted higher
   * than it has earned, which is where a running row is expected anyway.
   *
   * Seeding the map where the stream opens is what would close it, and what
   * either of those two changes would need: an age beside a spinner, or an
   * unread mark taken from the listed `settledAt` instead of from here.
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
    const { lines, images } = Attachments.render(taken);
    const text = [command.text, ...lines].filter(Boolean).join("\n\n").trim();
    this.prompt(stream, text, images);
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
   *
   * Which is why a turn that dies is announced rather than returned: the
   * response it would have failed is long since sent. A model that answers
   * with an error is a line in the log and reaches the client that way; what
   * is broadcast here is the turn that never got that far — a refused key, a
   * model that does not resolve — and would otherwise stop in silence.
   */
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
