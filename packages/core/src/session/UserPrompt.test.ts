import { expect, test } from "bun:test";

import { UserPrompt } from "./UserPrompt";

const SKILL =
  '<skill name="release" location="/s/SKILL.md">\n# Release\n</skill>';

const skill = { name: "release", content: "# Release" };

test.each([
  ["plain text is kept", "hello", { text: "hello", files: [] }],
  [
    "a skill alone is its command",
    SKILL,
    { text: "/skill:release", files: [], skill },
  ],
  [
    "a skill with words is the command as typed",
    `${SKILL}\n\ncut it`,
    { text: "/skill:release cut it", files: [], skill },
  ],
  [
    "a skill with words and a file sets the file apart",
    `${SKILL}\n\ncut it\n\n[Attachment: /up/notes.md]`,
    {
      text: "/skill:release cut it",
      files: [{ path: "/up/notes.md", isImage: false }],
      skill,
    },
  ],
])("%s", (_name, raw, prompt) => {
  expect(UserPrompt.of(raw)).toEqual(prompt);
});
