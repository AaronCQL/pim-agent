import "../test/dom";

import { afterEach, describe, expect, test } from "bun:test";

import { copyText } from "./clipboard";

const secure = navigator.clipboard;

/** An http origin has no `navigator.clipboard` at all — not a denied one. */
function insecureContext(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

/** happy-dom has no `execCommand`; the fallback needs one to call. */
function execCommand(result: boolean): () => string[] {
  const copied: string[] = [];
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      copied.push(document.getSelection()?.toString() ?? "");
      return result;
    },
  });
  return () => copied;
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: secure,
  });
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  test("uses the clipboard API where there is one", async () => {
    expect(await copyText("secure")).toBe(true);
    expect(await navigator.clipboard.readText()).toBe("secure");
  });

  /** The case this fallback exists for: the web UI reached over plain http. */
  test("falls back to the selection where there is not", async () => {
    insecureContext();
    const copied = execCommand(true);

    expect(await copyText("over http\nand a newline")).toBe(true);
    expect(copied()).toEqual(["over http\nand a newline"]);
    // Nothing of the carrier survives the copy.
    expect(document.body.querySelector("span")).toBe(null);
  });

  test("a fallback the browser refuses reports failure", async () => {
    insecureContext();
    execCommand(false);

    expect(await copyText("nope")).toBe(false);
  });

  test("with no way to copy at all, it says so rather than throwing", async () => {
    insecureContext();

    expect(await copyText("nothing doing")).toBe(false);
  });

  test("what the reader had selected is put back", async () => {
    const host = document.createElement("p");
    host.textContent = "a sentence someone was highlighting";
    document.body.append(host);
    const mine = document.createRange();
    mine.selectNodeContents(host);
    document.getSelection()?.addRange(mine);

    insecureContext();
    execCommand(true);
    await copyText("something else");

    expect(document.getSelection()?.toString()).toBe(
      "a sentence someone was highlighting"
    );
    host.remove();
  });
});
