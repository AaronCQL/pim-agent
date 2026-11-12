/** `held`: another surface is running a turn. `stale`: it wrote the session since this terminal last read it. */
export type GateState = "open" | "held" | "stale";

type Probe = () => Promise<GateState>;

/** session-lease's answer to "may this terminal write the session now?", for writers other than the user. */
export class SessionGate {
  private probe: Probe;
  private readonly listeners: Set<() => void>;

  public constructor() {
    this.probe = async () => "open";
    this.listeners = new Set();
  }

  public bind(probe: Probe): void {
    this.probe = probe;
  }

  /** A `stale` answer has already started catching up, unless the session is closing; the session is replaced once it has. */
  public async check(): Promise<GateState> {
    return await this.probe();
  }

  /** Fires whenever the answer may have changed. */
  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
