import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { applyPatch } from "./executor";
import { parsePatch } from "./parser";

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-apply-patch-"));
  tempRoots.push(root);
  return root;
};

const wrap = (body: string): string =>
  `*** Begin Patch\n${body}\n*** End Patch`;

const apply = (text: string, cwd: string) => applyPatch(parsePatch(text), cwd);

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("applyPatch", () => {
  test("updates a file via context", async () => {
    const root = await tempRoot();
    const path = join(root, "a.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    await apply(wrap("*** Update File: a.txt\n@@\n alpha\n-beta\n+BETA"), root);

    expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("updates a symlink target without replacing the symlink", async () => {
    const root = await tempRoot();
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "alpha\nbeta\n", "utf8");
    await symlink("target.txt", link);

    await apply(wrap("*** Update File: link.txt\n@@\n-beta\n+BETA"), root);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("alpha\nBETA\n");
    expect(await readFile(link, "utf8")).toBe("alpha\nBETA\n");
  });

  test("adds a new file", async () => {
    const root = await tempRoot();
    await apply(wrap("*** Add File: new.txt\n+one\n+two"), root);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("adds an empty file", async () => {
    const root = await tempRoot();
    await apply(wrap("*** Add File: empty.txt"), root);
    const path = join(root, "empty.txt");
    expect(await Bun.file(path).exists()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("");
  });

  test("deletes a file", async () => {
    const root = await tempRoot();
    const path = join(root, "gone.txt");
    await writeFile(path, "bye\n", "utf8");
    await apply(wrap("*** Delete File: gone.txt"), root);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("moves (renames) a file and applies the change", async () => {
    const root = await tempRoot();
    const src = join(root, "src.txt");
    const dest = join(root, "dest.txt");
    await writeFile(src, "x\ny\n", "utf8");

    await apply(
      wrap("*** Update File: src.txt\n*** Move to: dest.txt\n@@\n-x\n+X"),
      root
    );

    expect(await Bun.file(src).exists()).toBe(false);
    expect(await readFile(dest, "utf8")).toBe("X\ny\n");
  });

  test("pure rename moves the file with contents unchanged", async () => {
    const root = await tempRoot();
    const src = join(root, "from.txt");
    const dest = join(root, "to.txt");
    await writeFile(src, "keep\nme\n", "utf8");

    await apply(wrap("*** Update File: from.txt\n*** Move to: to.txt"), root);

    expect(await Bun.file(src).exists()).toBe(false);
    expect(await readFile(dest, "utf8")).toBe("keep\nme\n");
  });

  test("applies multiple chunks with recurring context", async () => {
    const root = await tempRoot();
    const path = join(root, "m.txt");
    await writeFile(path, "foo\nbar\nbaz\nqux\n", "utf8");

    await apply(
      wrap("*** Update File: m.txt\n@@ foo\n-bar\n+BAR\n@@ baz\n-qux\n+QUX"),
      root
    );

    expect(await readFile(path, "utf8")).toBe("foo\nBAR\nbaz\nQUX\n");
  });

  describe("conflict checks throw", () => {
    test("add existing file", async () => {
      const root = await tempRoot();
      await writeFile(join(root, "x.txt"), "hi\n", "utf8");
      await expect(
        apply(wrap("*** Add File: x.txt\n+hi"), root)
      ).rejects.toThrow("Use *** Update File to modify an existing file");
    });

    test("delete missing file", async () => {
      const root = await tempRoot();
      await expect(
        apply(wrap("*** Delete File: nope.txt"), root)
      ).rejects.toThrow("file does not exist. Use glob to locate the file");
    });

    test("update missing file", async () => {
      const root = await tempRoot();
      await expect(
        apply(wrap("*** Update File: nope.txt\n@@\n-a\n+b"), root)
      ).rejects.toThrow("Use *** Add File to create a new file");
    });

    test("update directory", async () => {
      const root = await tempRoot();
      await mkdir(join(root, "dir"));
      await expect(
        apply(wrap("*** Update File: dir\n@@\n-a\n+b"), root)
      ).rejects.toThrow("path is a directory. Target a UTF-8 text file");
    });

    test("move destination exists", async () => {
      const root = await tempRoot();
      await writeFile(join(root, "src.txt"), "a\n", "utf8");
      await writeFile(join(root, "dst.txt"), "b\n", "utf8");
      await expect(
        apply(
          wrap("*** Update File: src.txt\n*** Move to: dst.txt\n@@\n-a\n+A"),
          root
        )
      ).rejects.toThrow("Delete or rename the destination first");
    });

    test("add file below an existing file path", async () => {
      const root = await tempRoot();
      await writeFile(join(root, "existing.txt"), "a\n", "utf8");

      await expect(
        apply(wrap("*** Add File: existing.txt/child.txt\n+hi"), root)
      ).rejects.toThrow(
        "Cannot create parent directory existing.txt for existing.txt/child.txt"
      );
    });

    test("add file in an unwritable directory", async () => {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        return;
      }

      const root = await tempRoot();
      const blocked = join(root, "blocked");
      await mkdir(blocked);
      await chmod(blocked, 0o500);

      try {
        await expect(
          apply(wrap("*** Add File: blocked/new.txt\n+hi"), root)
        ).rejects.toThrow("Cannot write blocked/new.txt: permission denied");
      } finally {
        await chmod(blocked, 0o700);
      }
    });

    test("context not found", async () => {
      const root = await tempRoot();
      await writeFile(join(root, "a.txt"), "real\n", "utf8");
      await expect(
        apply(wrap("*** Update File: a.txt\n@@\n-missing\n+x"), root)
      ).rejects.toThrow("Failed to find expected lines in a.txt:\nmissing");
    });

    test("ambiguous expected lines ask for more context", async () => {
      const root = await tempRoot();
      const path = join(root, "a.txt");
      await writeFile(path, "same\ntarget\nsame\ntarget\n", "utf8");

      await expect(
        apply(wrap("*** Update File: a.txt\n@@\n same\n-target\n+TARGET"), root)
      ).rejects.toThrow(
        "Patch matched multiple regions in a.txt (lines 1, 3). Use enough context to make it unique."
      );
      expect(await readFile(path, "utf8")).toBe("same\ntarget\nsame\ntarget\n");
    });

    test("ambiguous context markers ask for more context", async () => {
      const root = await tempRoot();
      await writeFile(join(root, "a.txt"), "anchor\nx\nanchor\ny\n", "utf8");

      await expect(
        apply(wrap("*** Update File: a.txt\n@@ anchor\n-x\n+X"), root)
      ).rejects.toThrow(
        "Patch matched multiple regions in a.txt (lines 1, 3). Use enough context to make it unique."
      );
    });

    test("net no-op patch", async () => {
      const root = await tempRoot();
      await writeFile(join(root, "a.txt"), "same\n", "utf8");
      await expect(
        apply(wrap("*** Update File: a.txt\n@@\n same"), root)
      ).rejects.toThrow("did not change them");
    });
  });

  test("atomic: a failing later hunk produces zero writes", async () => {
    const root = await tempRoot();
    const ok = join(root, "ok.txt");
    await writeFile(ok, "alpha\n", "utf8");

    await expect(
      apply(
        wrap(
          "*** Update File: ok.txt\n@@\n-alpha\n+ALPHA\n*** Delete File: missing.txt"
        ),
        root
      )
    ).rejects.toThrow("Failed to delete file");

    // The successful update must NOT have been written.
    expect(await readFile(ok, "utf8")).toBe("alpha\n");
  });

  test("preserves a missing trailing newline", async () => {
    const root = await tempRoot();
    const path = join(root, "a.txt");
    await writeFile(path, "alpha\nbeta", "utf8");

    await apply(wrap("*** Update File: a.txt\n@@\n-beta\n+BETA"), root);

    expect(await readFile(path, "utf8")).toBe("alpha\nBETA");
  });

  test("preserves CRLF line endings", async () => {
    const root = await tempRoot();
    const path = join(root, "a.txt");
    await writeFile(path, "alpha\r\nbeta\r\n", "utf8");

    await apply(wrap("*** Update File: a.txt\n@@\n-beta\n+BETA"), root);

    expect(await readFile(path, "utf8")).toBe("alpha\r\nBETA\r\n");
  });

  test("preserves a UTF-8 BOM", async () => {
    const root = await tempRoot();
    const path = join(root, "a.txt");
    await writeFile(path, "﻿alpha\nbeta\n", "utf8");

    await apply(wrap("*** Update File: a.txt\n@@\n-beta\n+BETA"), root);

    const bytes = await Bun.file(path).bytes();
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(await readFile(path, "utf8")).toBe("﻿alpha\nBETA\n");
  });

  test("rejects a binary file on update", async () => {
    const root = await tempRoot();
    const path = join(root, "bin");
    await writeFile(path, Buffer.from([0x00, 0x01, 0x02]));
    await expect(
      apply(wrap("*** Update File: bin\n@@\n-a\n+b"), root)
    ).rejects.toThrow("apply_patch only supports UTF-8 text files");
  });
});
