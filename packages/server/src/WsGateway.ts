import type { Server, ServerWebSocket } from "bun";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { Attachments } from "#core/attachments/Attachments";
import { Directories } from "#core/shared/Directories";
import { Git } from "#core/shared/Git";
import { GitMonitor, type GitRun } from "#core/shared/GitMonitor";
import { PiExtensions, type ExtensionScope } from "#core/shared/PiExtensions";
import { RepoDiff } from "#core/shared/RepoDiff";
import { ReadCursors } from "#core/session/ReadCursors";
import type { SessionHost } from "#core/session/SessionHost";
import { SessionMeta } from "#core/session/SessionMeta";
import type { SessionRegistry } from "#core/session/SessionRegistry";
import { PimVersion } from "#core/shared/PimVersion";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import { Format } from "#core/shared/Format";
import type { UpdateOutcome } from "#core/shared/Updater";
import type { Command } from "#protocol/Command";
import type { ResponseEvent, ServerEvent } from "#protocol/ServerEvent";
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
  /** Defaults to `~/.pim/attachments`. */
  readonly attachmentsRoot?: string;
  /** Images cached by `read`. Defaults to `~/.pim/cache`. */
  readonly imagesRoot?: string;
  /** Defaults to `~/.pim/read.json`. */
  readonly readCursorsPath?: string;
  /** Defaults to `~/.pim/sessions.json`. */
  readonly sessionMetaPath?: string;
  /** Session file poll interval. Defaults to 1s. */
  readonly pollMs?: number;
  /** Defaults to 3 minutes. */
  readonly requestCeilingMs?: number;
  /** Defaults to 15s. */
  readonly detachGraceMs?: number;
  /** Defaults to the bundled web client. */
  readonly clientDir?: string;
  readonly update?: (onStep: (label: string) => void) => Promise<UpdateOutcome>;
  readonly shutdown?: () => Promise<void>;
};

type Outcome = Omit<ResponseEvent, "type" | "id" | "success"> & {
  /** Runs after the response is sent. */
  readonly after?: () => void;
};

type StreamTarget = {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly like?: SessionHost;
};

export const DEFAULT_PORT = 4319;

export const DEFAULT_HOSTNAME = "127.0.0.1";

// Bun 1.3.14 can hang in `Server.stop(true)` after closing sockets server-side.
const STOP_GRACE_MS = 250;

/** Mirrors pi's `_tryExecuteExtensionCommand` parse (`agent-session.js:954`). */
function commandNameOf(text: string): string {
  const spaceIndex = text.indexOf(" ");
  return spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
}

/** WebSocket + HTTP endpoint over the session runtime in `core`. */
export class WsGateway {
  private readonly registry: SessionRegistry;
  private readonly hostname: string;
  private readonly requestedPort: number;
  private readonly uploads: AttachmentEndpoint;
  private readonly images: ImageEndpoint;
  private readonly catalogue: SessionCatalogue;
  private readonly meta: SessionMeta;
  private readonly client: StaticClient;
  private readonly streams = new Map<string, SessionStream>();
  private readonly opening = new Map<string, Promise<SessionStream>>();
  /** Sessions clients are opening or attaching to, with how many are. */
  private readonly attaching = new Map<string, number>();
  private readonly connections = new Map<
    ServerWebSocket<undefined>,
    ClientConnection
  >();
  private readonly reloader: Reloader;
  private readonly git = new GitMonitor();
  private readonly pollMs: number | undefined;
  private readonly requestCeilingMs: number | undefined;
  private readonly detachGraceMs: number | undefined;
  private readonly busyRepos = new Set<string>();
  private versionsRead: Promise<readonly [string, string]> | undefined;
  private server: Server<undefined> | undefined;

  public constructor(deps: WsGatewayDeps) {
    this.registry = deps.registry;
    this.registry.bind({
      ui: (host) =>
        host.sessionId === undefined
          ? undefined
          : this.streams.get(host.sessionId),
      holds: (sessionId) =>
        this.attaching.has(sessionId) ||
        this.isAttached(sessionId) ||
        this.isWorking(sessionId),
      evicted: (sessionId) => {
        this.streams.get(sessionId)?.dispose();
        this.streams.delete(sessionId);
      },
    });
    this.hostname = deps.hostname ?? DEFAULT_HOSTNAME;
    this.requestedPort = deps.port ?? DEFAULT_PORT;
    this.pollMs = deps.pollMs;
    this.requestCeilingMs = deps.requestCeilingMs;
    this.detachGraceMs = deps.detachGraceMs;
    this.uploads = new AttachmentEndpoint(
      deps.attachmentsRoot === undefined ? {} : { root: deps.attachmentsRoot }
    );
    this.images = new ImageEndpoint(
      deps.imagesRoot === undefined ? {} : { root: deps.imagesRoot }
    );
    this.meta = new SessionMeta(deps.sessionMetaPath);
    this.catalogue = new SessionCatalogue({
      registry: deps.registry,
      cursors: new ReadCursors(deps.readCursorsPath),
      meta: this.meta,
      liveActivity: (sessionId) => {
        const host = this.streams.get(sessionId)?.host;
        return host && { status: host.status, jobs: host.jobCount };
      },
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
          return this.versions().then(([pimVersion]) =>
            Response.json({ ok: true, pimVersion })
          );
        }
        if (AttachmentEndpoint.owns(pathname)) {
          return this.uploads.handle(req);
        }
        if (ImageEndpoint.owns(pathname)) {
          return this.images.handle(req);
        }
        // The socket must answer on every path.
        return server.upgrade(req) ? undefined : this.client.handle(req);
      },
      websocket: {
        backpressureLimit: 8 << 20,
        closeOnBackpressureLimit: false,
        // Dedicated keeps the window between frames, which shrinks the repeated envelopes.
        perMessageDeflate: { compress: "dedicated", decompress: "dedicated" },
        open: (ws) => {
          this.connections.set(ws, new ClientConnection(ws));
          this.syncWatches();
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
          this.syncWatches();
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
    this.attaching.clear();
    this.git.dispose();
    this.busyRepos.clear();
    this.catalogue.watch(false);
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
      case "attention": {
        const regained = command.value && !connection.attentive;
        connection.setAttentive(command.value);
        const sessionId = connection.sessionId;
        if (regained && sessionId !== undefined) {
          await this.catalogue.markRead(sessionId);
        }
        return {};
      }
      case "list_sessions":
        return await this.catalogue.list(command);
      case "search_sessions":
        return await this.catalogue.search(command);
      // These may target a session this server never opened, so they must not need a stream.
      case "set_session_name": {
        const name = await this.registry.setName(
          command.sessionId,
          command.value
        );
        this.broadcast({
          type: "session_meta",
          sessionId: command.sessionId,
          name: name ?? null,
        });
        return {};
      }
      case "set_session_archived":
        await this.meta.setArchived(command.sessionId, command.value);
        this.broadcast({
          type: "session_meta",
          sessionId: command.sessionId,
          archived: command.value,
        });
        return {};
      case "set_session_unread":
        await this.meta.setUnread(command.sessionId, command.value);
        this.broadcast({
          type: "session_meta",
          sessionId: command.sessionId,
          unread: command.value,
        });
        return {};
      case "set_project_pinned":
        await this.meta.setPinned(command.cwd, command.value);
        this.broadcast({
          type: "project_meta",
          cwd: command.cwd,
          pinned: command.value,
        });
        this.broadcast({ type: "pins_changed", order: await this.meta.pins() });
        return {};
      case "set_project_expanded":
        await this.meta.setExpanded(command.cwd, command.value);
        this.broadcast({
          type: "project_meta",
          cwd: command.cwd,
          expanded: command.value,
        });
        return {};
      case "set_project_label":
        await this.meta.setLabel(command.cwd, command.value);
        this.broadcast({
          type: "project_meta",
          cwd: command.cwd,
          label: command.value,
        });
        return {};
      case "set_pin_order":
        await this.meta.setPinOrder(command.order);
        this.broadcast({ type: "pins_changed", order: await this.meta.pins() });
        return {};
      case "list_models":
        return {
          models: this.registry.models(),
          thinkingLevels:
            this.streamFor(connection)?.host.supportedThinkingLevels ?? [],
        };
      case "list_extensions":
        return {
          extensions: await PiExtensions.list(this.scopeFor(connection)),
        };
      case "set_extension":
        await PiExtensions.setEnabled(
          command.extensionId,
          command.value,
          this.scopeFor(connection)
        );
        return {
          after: () => {
            this.rebuildAgents();
          },
        };
      case "list_dirs":
        return { directory: await Directories.list(command.path) };
      case "create_dir":
        await Directories.create(command.path);
        return {};
      case "refresh_git": {
        const stream = this.requireStream(connection);
        await stream.refreshGit(command.fetch === true);
        return {};
      }
      case "list_branches":
        return {
          branches: await Git.listBranches(
            this.requireStream(connection).host.cwd
          ),
        };
      // Read-only, so allowed while `repoBusy`.
      case "list_changes":
        return {
          changes: await RepoDiff.listChanges(
            this.requireStream(connection).host.cwd,
            command.base,
            this.git
          ),
        };
      case "file_diff":
        return {
          fileDiff: await RepoDiff.fileDiff(
            this.requireStream(connection).host.cwd,
            command.base,
            command.path,
            this.git,
            command.context
          ),
        };
      case "read_lines":
        return {
          fileLines: await RepoDiff.readLines(
            this.requireStream(connection).host.cwd,
            command.base,
            command.path,
            command.spans,
            this.git
          ),
        };
      case "checkout": {
        const stream = this.requireStream(connection);
        return await this.runGit(stream, true, (cwd) =>
          Git.checkout(cwd, command.branch)
        );
      }
      case "commit":
        return await this.commit(this.requireStream(connection), command);
      case "pull":
      case "push":
        return await this.runGit(
          this.requireStream(connection),
          command.type === "pull",
          command.type === "pull" ? Git.pull : Git.push
        );
      case "unwatch_subagent":
        connection.unwatchSubagent(command.callId);
        return {};
      case "reload":
        return await this.reload(command.force === true);
      case "user_message":
        return await this.promptWithAttachments(
          this.requireStream(connection),
          command
        );
      case "ui_response": {
        const stream = this.requireStream(connection);
        return stream.answer(command.requestId, command)
          ? {}
          : { error: `no request ${command.requestId} is waiting` };
      }
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
        stream.syncGit();
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
      case "set_subagent": {
        const stream = this.requireStream(connection);
        const { model, thinking } = command;
        if (
          typeof model === "string" &&
          !this.registry.models().some((choice) => choice.id === model)
        ) {
          return { error: `unknown model "${model}"` };
        }
        await stream.host.setSubagentChoice({
          model,
          thinking: thinking as ThinkingLevel | null | undefined,
        });
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

  /** Uses the process cwd when the connection is not attached. */
  private scopeFor(connection: ClientConnection): ExtensionScope {
    return {
      cwd: this.streamFor(connection)?.host.cwd ?? process.cwd(),
      agentDir: this.registry.agentDir,
    };
  }

  private rebuildAgents(): void {
    for (const stream of this.streams.values()) {
      const { host } = stream;
      // Queued behind any running turn, which detaching the agent would kill.
      void host
        .serialize(() => host.invalidate())
        .catch((err: unknown) => {
          this.failed(stream, err, "extension reload");
        });
    }
    this.broadcast({ type: "extensions_changed" });
  }

  private requireStream(connection: ClientConnection): SessionStream {
    const stream = this.streamFor(connection);
    if (!stream) {
      throw new Error("not attached: send `attach` first");
    }
    return stream;
  }

  // The log path is derived server-side; never accept a client-sent path.
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
    // A running call may not have written its log yet.
    if (!stream.isRunning(command.callId) && !(await Bun.file(path).exists())) {
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
    const attentive = command.attentive !== false;
    const like =
      command.like === undefined
        ? undefined
        : this.streams.get(command.like)?.host;
    const { stream, release } = await this.ensureStream({
      ...(command.sessionId === undefined
        ? {}
        : { sessionId: command.sessionId }),
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      ...(like === undefined ? {} : { like }),
    });
    try {
      const [pimVersion, piVersion] = await this.versions();
      connection.send({
        type: "attached",
        sessionId: stream.sessionId,
        cwd: stream.host.cwd,
        head: await stream.refresh(),
        pimVersion,
        piVersion,
      });
      await connection.attach(stream, command.fromSeq, attentive);
    } finally {
      release();
    }
    this.syncWatches();
    if (attentive) {
      await this.catalogue.markRead(stream.sessionId);
    }
    return {};
  }

  /** Watches only attached sessions, and the catalogue only while anyone is connected. */
  private syncWatches(): void {
    for (const [sessionId, stream] of this.streams) {
      // Attached, not attentive: hidden tabs still need updates.
      stream.watchFiles(this.isAttached(sessionId));
    }
    this.catalogue.watch(this.connections.size > 0);
  }

  /** `movesTree` operations are refused while an agent in the cwd is mid-turn or running subagents. */
  private async runGit<T = never>(
    stream: SessionStream,
    movesTree: boolean,
    operation: (cwd: string) => Promise<GitRun<T>>
  ): Promise<Outcome & { readonly value?: T }> {
    const cwd = stream.host.cwd;
    const busy = movesTree ? this.busyIn(cwd) : [];
    if (busy.length > 0) {
      return {
        error: `${await this.busyText(busy)} working in ${cwd}; wait for ${busy.length > 1 ? "them" : "it"} to finish`,
      };
    }
    const result = await this.git.run<T>(cwd, () => operation(cwd));
    if (!result.ok) {
      return { error: result.error };
    }
    return result.value === undefined ? {} : { value: result.value };
  }

  private async commit(
    stream: SessionStream,
    command: Command & { readonly type: "commit" }
  ): Promise<Outcome> {
    const { value, ...outcome } = await this.runGit<string>(
      stream,
      true,
      async (cwd) => {
        const result = await Git.commit(cwd, {
          message: command.message,
          paths: command.paths,
        });
        return result.ok
          ? { ok: true, value: result.sha }
          : { ok: false, error: result.error };
      }
    );
    return value === undefined ? outcome : { commit: { sha: value } };
  }

  /** Mid-turn, or running background subagents for any surface in this process. */
  private isWorking(sessionId: string): boolean {
    const host = this.streams.get(sessionId)?.host;
    return (
      (host !== undefined && host.status !== "idle") ||
      this.registry.jobs?.hasRunning(sessionId) === true
    );
  }

  /** Every working session; with `cwd`, those known to work there. */
  private busyIn(cwd?: string): readonly string[] {
    const sessionIds = new Set([
      ...this.streams.keys(),
      ...(this.registry.jobs?.runningSessions() ?? []),
    ]);
    return [...sessionIds].filter(
      (sessionId) =>
        (cwd === undefined || this.streams.get(sessionId)?.host.cwd === cwd) &&
        this.isWorking(sessionId)
    );
  }

  /** `"fix the parser" (mid-turn) is` / `"a" (2 subagents), b8f1… (mid-turn) are`. */
  private async busyText(busy: readonly string[]): Promise<string> {
    const named = await Promise.all(
      busy.map(async (sessionId) => {
        const stream = this.streams.get(sessionId);
        const jobs = this.registry.jobs?.count(sessionId) ?? 0;
        const doing = [
          ...(stream === undefined || stream.host.status === "idle"
            ? []
            : ["mid-turn"]),
          ...(jobs === 0 ? [] : [Format.count(jobs, "subagent")]),
        ];
        const title =
          stream &&
          (await this.catalogue.titleOf(sessionId, stream.sessionPath));
        const name =
          title === undefined
            ? sessionId
            : `"${title.replace(/\s+/gu, " ").trim()}"`;
        return `${name} (${doing.join(", ")})`;
      })
    );
    return `${named.join(", ")} ${busy.length > 1 ? "are" : "is"}`;
  }

  private repoBusy(cwd: string): boolean {
    return this.busyIn(cwd).length > 0;
  }

  /** Pushes fresh state to the sessions in `cwd`, bar `source`, when its busy flag flips. */
  private syncRepoBusy(cwd: string, source?: string): void {
    const busy = this.repoBusy(cwd);
    if (this.busyRepos.has(cwd) === busy) {
      return;
    }
    if (busy) {
      this.busyRepos.add(cwd);
    } else {
      this.busyRepos.delete(cwd);
    }
    for (const [sessionId, stream] of this.streams) {
      if (sessionId !== source && stream.host.cwd === cwd) {
        stream.push(stream.sessionState());
      }
    }
  }

  private async reload(force: boolean): Promise<Outcome> {
    const busy = force ? [] : this.busyIn();
    if (busy.length > 0) {
      return {
        error: `${await this.busyText(busy)} working; reloading would kill that work. Send \`reload\` with \`force\` to do it anyway`,
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

  private isAttached(sessionId: string): boolean {
    return this.connections
      .values()
      .some((connection) => connection.sessionId === sessionId);
  }

  private isBeingRead(sessionId: string): boolean {
    return this.connections
      .values()
      .some(
        (connection) =>
          connection.sessionId === sessionId && connection.attentive
      );
  }

  private broadcast(event: ServerEvent): void {
    for (const connection of this.connections.values()) {
      connection.send(event);
    }
  }

  /** The stream for `target`, kept from eviction until `release` runs. */
  private async ensureStream(
    target: StreamTarget
  ): Promise<{ readonly stream: SessionStream; readonly release: () => void }> {
    const sessionId = target.sessionId;
    let release = sessionId ? this.hold(sessionId) : (): void => {};
    try {
      const stream = sessionId
        ? await this.openStream(sessionId, target)
        : await this.buildStream(target, (id) => {
            release = this.hold(id);
          });
      return { stream, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  private async openStream(
    sessionId: string,
    target: StreamTarget
  ): Promise<SessionStream> {
    const live = this.streams.get(sessionId);
    if (live) {
      return live;
    }
    const pending = this.opening.get(sessionId);
    if (pending) {
      return await pending;
    }
    const build = this.buildStream(target);
    this.opening.set(sessionId, build);
    try {
      return await build;
    } finally {
      this.opening.delete(sessionId);
    }
  }

  private hold(sessionId: string): () => void {
    this.attaching.set(sessionId, (this.attaching.get(sessionId) ?? 0) + 1);
    return () => {
      const left = (this.attaching.get(sessionId) ?? 1) - 1;
      if (left === 0) {
        this.attaching.delete(sessionId);
      } else {
        this.attaching.set(sessionId, left);
      }
    };
  }

  /** `named` runs as soon as the session's id is known, before anything else can run. */
  private async buildStream(
    target: StreamTarget,
    named?: (sessionId: string) => void
  ): Promise<SessionStream> {
    const sessionId = target.sessionId;
    const host = sessionId
      ? await this.registry.open(sessionId)
      : await this.registry.create({
          ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
          ...(target.like === undefined ? {} : { like: target.like }),
        });
    // Pi assigns the id and session file only once an agent exists.
    const agent = host.agentSession ?? (await host.ensureAgent());
    const id = agent.sessionId;
    const path = agent.sessionFile ?? host.settings.sessionPath;
    if (!path) {
      throw new Error(`session ${sessionId ?? "(new)"} has no agent`);
    }
    named?.(id);
    const existing = this.streams.get(id);
    if (existing) {
      return existing;
    }
    const stream = new SessionStream(id, host, path, {
      git: this.git,
      repoBusy: () => this.repoBusy(host.cwd),
      pollMs: this.pollMs,
      requestCeilingMs: this.requestCeilingMs,
      detachGraceMs: this.detachGraceMs,
    });
    stream.start();
    this.catalogue.track(id, { status: host.status, jobs: host.jobCount });
    // Observe, not subscribe, so this doesn't count as an attached client.
    stream.observe((event) => {
      if (event.type === "session_state") {
        this.catalogue.onActivity(id, {
          status: event.status,
          jobs: stream.host.jobCount,
        });
        this.syncRepoBusy(stream.host.cwd, id);
      } else if (event.type === "jobs") {
        this.catalogue.onActivity(id, {
          status: stream.host.status,
          jobs: event.jobs.length,
        });
        this.syncRepoBusy(stream.host.cwd);
      }
    });
    this.streams.set(id, stream);
    return stream;
  }

  private async promptWithAttachments(
    stream: SessionStream,
    command: Command & { readonly type: "user_message" }
  ): Promise<Outcome> {
    // Pi trims before dispatching, so trim here too or a padded command slips past this check.
    const text = command.text.trim();
    const dispatched = await this.dispatchCommand(stream, text);
    const taken = this.uploads.take(
      stream.sessionId,
      (command.attachments ?? []).map((ref) => ref.id)
    );
    // Uploads are taken even for commands, so the endpoint releases them.
    if (dispatched) {
      return { dispatched: true };
    }
    const { lines, images } = Attachments.render(taken);
    this.prompt(stream, [text, ...lines].filter(Boolean).join("\n\n"), images);
    return {};
  }

  /** Starts `text` if it is an extension command; only the decision is awaited. */
  private async dispatchCommand(
    stream: SessionStream,
    text: string
  ): Promise<boolean> {
    const host = stream.host;
    if (!text.startsWith("/")) {
      return false;
    }
    const agent = host.agentSession ?? (await host.ensureAgent());
    const name = commandNameOf(text);
    if (agent.extensionRunner.getCommand(name) === undefined) {
      return false;
    }
    void stream
      .dispatch(`/${name}`, async () => {
        // Never merged into the queue, or the leading `/` would be lost.
        if (host.isStreaming) {
          await agent.prompt(text, {
            streamingBehavior: "steer",
            source: "rpc",
          });
          return;
        }
        await host.run(async (session) => {
          await session.prompt(text, { source: "rpc" });
        });
      })
      .catch((err: unknown) => {
        this.failed(stream, err, "command");
      });
    return true;
  }

  // Merge with the queued message: pi holds at most one.
  private prompt(
    stream: SessionStream,
    text: string,
    images: readonly ImageContent[] = []
  ): void {
    const attached = images.length === 0 ? {} : { images: [...images] };
    const host = stream.host;
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
          this.failed(stream, err, "steer");
        });
      return;
    }
    void host
      .run(async (session) => {
        await session.prompt(text, { source: "rpc", ...attached });
      })
      .catch((err: unknown) => {
        this.failed(stream, err, "turn");
      });
  }

  private failed(stream: SessionStream, err: unknown, what: string): void {
    console.error(`[gateway] ${what} failed:`, err);
    stream.push({
      type: "error",
      message: (err as Error).message || String(err),
    });
  }
}
