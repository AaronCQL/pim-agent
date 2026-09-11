import { expect, test } from "bun:test";

import type { StoredAttachment } from "./AttachmentStore";
import { Attachments } from "./Attachments";

function stored(path: string, imageBase64?: string): StoredAttachment {
  return {
    id: path.split("/").pop()!,
    path,
    mimeType: imageBase64 === undefined ? "text/plain" : "image/png",
    imageBase64,
  };
}

test("what render writes into a prompt, parse takes back out of it", () => {
  const files = [
    stored("/srv/attachments/s1/shot-1730000000000.png", "AAAA"),
    stored("/srv/attachments/s1/notes-1730000000001.txt"),
  ];

  const { lines } = Attachments.render(files);
  const said = Attachments.parse(["look at these", ...lines].join("\n\n"));

  expect(said.text).toBe("look at these");
  expect(said.files).toEqual([
    { path: files[0]!.path, isImage: true },
    { path: files[1]!.path, isImage: false },
  ]);
});

test("a message that is only files has nothing left to say", () => {
  const { lines } = Attachments.render([
    stored("/srv/a/s1/x-1730000000000.png", "AA"),
  ]);

  expect(Attachments.parse(lines.join("\n\n")).text).toBe("");
});

test("a message with no files is not touched on the way through", () => {
  const said = "  spaced out\n\nand [bracketed: not a marker]  ";

  expect(Attachments.parse(said).text).toBe(said);
  expect(Attachments.parse(said).files).toEqual([]);
});

// A session file is history: a marker written by an older pim, or by another
// frontend spelling it differently, is still the only record that the message
// had a file on it.
test("either spelling of the marker is read", () => {
  const said = Attachments.parse(
    "[image attachment: /srv/a/one.png]\n[ATTACHMENT: /srv/a/two.pdf]"
  );

  expect(said.files).toEqual([
    { path: "/srv/a/one.png", isImage: true },
    { path: "/srv/a/two.pdf", isImage: false },
  ]);
});

test("a stored name is shown without the stamp that made it unique", () => {
  expect(Attachments.nameOf("/srv/a/s1/holiday-photo-1730000000000.png")).toBe(
    "holiday-photo.png"
  );
  expect(Attachments.nameOf("/srv/a/s1/notes-1730000000000.txt")).toBe(
    "notes.txt"
  );
  // Nothing stamped it, so there is nothing to take off.
  expect(Attachments.nameOf("/home/me/report.pdf")).toBe("report.pdf");
});
