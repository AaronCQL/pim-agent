import { parseArgs } from "node:util";

import type { AttachmentRef } from "#protocol/Command";
import { isDurableEvent, type ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";

const USAGE = `pim probe — CLI client for pim-server, dumps every frame as JSONL

  bun run probe [options]

  --url <ws://host:port>   server to connect to (default ws://127.0.0.1:4319)
  --session <uuid>         attach to an existing session (default: create one)
  --cwd <path>             cwd for a session this probe creates
  --from-seq <n>           resume from this durable seq (default 0)
  --prompt <text>          send a user message once attached
  --pick-files <query>     ask the server to complete an @ path, print the rows
  --pick-commands <query>  ask the server for matching skills and commands
  --list-sessions          print pi's session catalogue and exit
  --upload <path>          transfer a local file to the server, attach it to
                           --prompt (repeatable)
  --steer <text>           steer the turn in flight instead of prompting
  --cancel                 cancel the current turn
  --approve                answer every approval request with yes
  --deny                   answer every approval request with no
  --wait                   keep streaming after the turn ends (Ctrl-C to stop)
  --quiet                  print only durable events
  --protocol-version <n>   override the handshake version (to test rejection)
`;

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "ws://127.0.0.1:4319" },
    session: { type: "string" },
    cwd: { type: "string" },
    "from-seq": { type: "string", default: "0" },
    prompt: { type: "string" },
    "pick-files": { type: "string" },
    "pick-commands": { type: "string" },
    "list-sessions": { type: "boolean", default: false },
    upload: { type: "string", multiple: true },
    steer: { type: "string" },
    cancel: { type: "boolean", default: false },
    approve: { type: "boolean", default: false },
    deny: { type: "boolean", default: false },
    wait: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    "protocol-version": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function dump(event: ServerEvent): void {
  if (event.type === "approval_request" && (values.approve || values.deny)) {
    void probe.approve(event.callId, values.approve);
  }
  if (values.quiet && !isDurableEvent(event)) {
    return;
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const probe = new ProbeClient({
  url: values.url,
  ...(values.session === undefined ? {} : { sessionId: values.session }),
  ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
  fromSeq: Number(values["from-seq"]),
  ...(values["protocol-version"] === undefined
    ? {}
    : { protocolVersion: Number(values["protocol-version"]) }),
  onEvent: dump,
});

const attached = await probe.connect();
if (!attached.success) {
  process.stderr.write(`attach failed: ${attached.error ?? "unknown error"}\n`);
  process.exit(1);
}

const mark = probe.events.length;
if (values["pick-files"] !== undefined) {
  const started = Bun.nanoseconds();
  const items = await probe.files.rank(values["pick-files"], { limit: 50 });
  const ms = (Bun.nanoseconds() - started) / 1e6;
  process.stderr.write(
    `pick-files: ${items?.length ?? 0} rows in ${ms.toFixed(1)}ms\n`
  );
  for (const item of items ?? []) {
    process.stdout.write(`${JSON.stringify(item)}\n`);
  }
}
if (values["list-sessions"]) {
  for (const summary of await probe.listSessions(values.cwd)) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
}
if (values["pick-commands"] !== undefined) {
  const items = await probe.pickCommands(values["pick-commands"]);
  process.stderr.write(`pick-commands: ${items.length} rows\n`);
  for (const item of items) {
    process.stdout.write(`${JSON.stringify(item)}\n`);
  }
}

const uploaded: AttachmentRef[] = [];
for (const path of values.upload ?? []) {
  const file = await probe.upload(path);
  uploaded.push({ id: file.id });
  process.stderr.write(`uploaded: ${JSON.stringify(file)}\n`);
}

if (values.cancel) {
  const response = await probe.send({
    type: "cancel",
    sessionId: probe.sessionId ?? "",
  });
  process.stderr.write(`cancel: ${JSON.stringify(response)}\n`);
}
if (values.steer !== undefined) {
  await probe.send({
    type: "steer",
    sessionId: probe.sessionId ?? "",
    text: values.steer,
  });
}
if (values.prompt !== undefined) {
  await probe.promptWith(values.prompt, uploaded);
}

if (values.prompt !== undefined || values.steer !== undefined) {
  await probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { timeoutMs: 10 * 60_000, from: mark }
  );
}

if (values.wait) {
  await new Promise<never>(() => {});
}
probe.close();
process.stderr.write(`session ${probe.sessionId} @ seq ${probe.seq}\n`);
