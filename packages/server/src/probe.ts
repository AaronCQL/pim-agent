import { parseArgs } from "node:util";

import {
  isDurableEvent,
  type ServerEvent,
} from "../../protocol/src/ServerEvent";
import { ProbeClient } from "./ProbeClient";

const USAGE = `pim probe — CLI client for pim-server, dumps every frame as JSONL

  bun run probe [options]

  --url <ws://host:port>   server to connect to (default ws://127.0.0.1:4319)
  --session <uuid>         attach to an existing session (default: create one)
  --cwd <path>             cwd for a session this probe creates
  --from-seq <n>           resume from this durable seq (default 0)
  --prompt <text>          send a user message once attached
  --steer <text>           steer the turn in flight instead of prompting
  --cancel                 cancel the current turn
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
    steer: { type: "string" },
    cancel: { type: "boolean", default: false },
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
  await probe.prompt(values.prompt);
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
