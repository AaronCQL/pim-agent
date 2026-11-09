import { Shutdown } from "../Shutdown";

const say = (line: string) => () => {
  console.log(line);
};

switch (process.argv[2]) {
  case "hooks": {
    const first = say("first");
    Shutdown.onExit(first);
    Shutdown.onExit(first);
    Shutdown.onExit(() => {
      throw new Error("a broken hook");
    });
    Shutdown.onExit(say("last"));
    process.exit(3);
    break;
  }
  case "owned": {
    await import("@earendil-works/pi-coding-agent");
    Shutdown.exitOn(["SIGINT"]);
    Shutdown.onExit(say("hook"));
    break;
  }
  case "suspended": {
    await import("@earendil-works/pi-coding-agent");
    Shutdown.exitOn(["SIGINT"]);
    Shutdown.onExit(say("hook"));
    const suspend = (): void => {
      process.off("SIGINT", suspend);
      console.log("ignored");
    };
    process.on("SIGINT", suspend);
    break;
  }
  case "request": {
    const signalled = Shutdown.untilSignal();
    Shutdown.requestStop();
    console.log(`owner got ${await signalled}`);
    process.exit(0);
  }
}

setInterval(() => {}, 1 << 30);
console.log("ready");
