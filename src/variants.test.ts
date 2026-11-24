import type { Context, HttpRequest } from "@yaakapp/api";
import { describe, expect, test } from "vitest";
import {
  BLOCK_TAG,
  CorruptVariantsError,
  deleteVariant,
  loadVariants,
  parseVariants,
  saveVariant,
  writeVariants,
} from "./variants";

function fakeCtx(initial: Partial<HttpRequest> = {}) {
  const stored = new Map<string, unknown>();
  const requests = new Map<string, HttpRequest>();
  const base = {
    id: "req_1",
    workspaceId: "wk_1",
    name: "Create user",
    url: "https://api.example.com/users",
    description: "",
    body: { text: "{}" },
    bodyType: "application/json",
    ...initial,
  } as HttpRequest;
  requests.set(base.id, base);
  const ctx = {
    store: {
      async get(key: string) {
        return stored.get(key);
      },
      async set(key: string, value: unknown) {
        stored.set(key, value);
      },
      async delete(key: string) {
        return stored.delete(key);
      },
    },
    httpRequest: {
      async getById({ id }: { id: string }) {
        return requests.get(id) ?? null;
      },
      async update(args: HttpRequest) {
        requests.set(args.id, args);
        return args;
      },
    },
  } as unknown as Context;
  return { ctx, stored, current: () => requests.get("req_1") as HttpRequest, base };
}

const a = { body: { text: "a" }, bodyType: "text/plain" };
const b = { body: { text: "b" }, bodyType: "text/plain" };

describe("description block format", () => {
  test("no block means no variants", () => {
    expect(parseVariants("")).toEqual({});
    expect(parseVariants("Just some docs")).toEqual({});
    expect(parseVariants(undefined)).toEqual({});
  });

  test("round-trips through the description, keeping user text", () => {
    const desc = writeVariants("Creates a user.", { minimal: a });
    expect(desc.startsWith("Creates a user.\n\n```" + BLOCK_TAG + "\n")).toBe(true);
    expect(parseVariants(desc)).toEqual({ minimal: a });
  });

  test("is deterministic: sorted names and keys for clean diffs", () => {
    const one = writeVariants("", { zeta: b, alpha: { bodyType: "x", body: { z: 1, a: 2 } } });
    const two = writeVariants("", { alpha: { body: { a: 2, z: 1 }, bodyType: "x" }, zeta: b });
    expect(one).toBe(two);
    expect(one.indexOf('"alpha"')).toBeLessThan(one.indexOf('"zeta"'));
  });

  test("replaces the block in place and keeps text before and after it", () => {
    const first = writeVariants("Intro", { minimal: a });
    const withOutro = `${first}\nOutro notes`;
    const updated = writeVariants(withOutro, { full: b });
    expect(updated.startsWith("Intro\n\n```")).toBe(true);
    expect(updated.trimEnd().endsWith("Outro notes")).toBe(true);
    expect(parseVariants(updated)).toEqual({ full: b });
    expect(updated.match(new RegExp(BLOCK_TAG, "g"))?.length).toBe(1);
  });

  test("removes the block when the last variant goes away", () => {
    const desc = writeVariants("Intro", { minimal: a });
    expect(writeVariants(desc, {})).toBe("Intro\n");
    expect(writeVariants(writeVariants("", { minimal: a }), {})).toBe("");
  });

  test("survives bodies that contain backtick fences", () => {
    const tricky = { body: { text: "```js\ncode\n````" }, bodyType: "text/plain" };
    const desc = writeVariants("", { tricky });
    expect(desc.startsWith("`````" + BLOCK_TAG)).toBe(true);
    expect(parseVariants(desc)).toEqual({ tricky });
  });

  test("accepts CRLF line endings from a Windows checkout", () => {
    const desc = writeVariants("Intro", { minimal: a }).replace(/\n/g, "\r\n");
    expect(parseVariants(desc)).toEqual({ minimal: a });
  });

  test("rejects a broken block instead of reading it as empty", () => {
    expect(() => parseVariants("```" + BLOCK_TAG + "\n{ not json\n```")).toThrow(
      CorruptVariantsError,
    );
    expect(() => parseVariants("```" + BLOCK_TAG + '\n{"variants":{"x":1}}\n```')).toThrow(
      CorruptVariantsError,
    );
  });
});

describe("v2 line format", () => {
  const block = (content: string) => "```" + BLOCK_TAG + "\n" + content + "\n```";

  test("writes a header plus exactly one line per variant", () => {
    const multiline = { body: { text: '{\n  "a": 1\n}' }, bodyType: "application/json" };
    const desc = writeVariants("", { zeta: b, alpha: multiline });
    expect(desc).toBe(
      block(
        [
          '{"version":2}',
          '{"name":"alpha","bodyType":"application/json","body":{"text":"{\\n  \\"a\\": 1\\n}"}}',
          '{"name":"zeta","bodyType":"text/plain","body":{"text":"b"}}',
        ].join("\n"),
      ) + "\n",
    );
    expect(parseVariants(desc)).toEqual({ alpha: multiline, zeta: b });
  });

  test("changing one variant changes exactly one line", () => {
    const before = writeVariants("", { one: a, two: a, three: a }).split("\n");
    const after = writeVariants("", { one: a, two: b, three: a }).split("\n");
    const changed = before.filter((line, i) => line !== after[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('"name":"two"');
  });

  test("keeps a null bodyType", () => {
    const none = { body: {}, bodyType: null };
    expect(parseVariants(writeVariants("", { none }))).toEqual({ none });
  });

  test("rejects duplicate names, unnamed lines and unknown versions", () => {
    const line = '{"name":"x","bodyType":null,"body":{}}';
    expect(() => parseVariants(block(`{"version":2}\n${line}\n${line}`))).toThrow(/twice/);
    expect(() => parseVariants(block('{"version":2}\n{"bodyType":null,"body":{}}'))).toThrow(
      /no variant name/,
    );
    expect(() => parseVariants(block('{"version":3}'))).toThrow(/version 3/);
  });

  test("still reads the v1 pretty-printed format", () => {
    const v1 = block(
      JSON.stringify({ version: 1, variants: { minimal: a, full: b } }, null, 2),
    );
    expect(parseVariants(v1)).toEqual({ minimal: a, full: b });
  });

  test("rewrites a v1 block as v2 on the next save, keeping its variants", async () => {
    const v1 = "Docs\n\n" + block(JSON.stringify({ version: 1, variants: { minimal: a } }, null, 2));
    const { ctx, current } = fakeCtx({ description: v1 });
    await saveVariant(ctx, current(), "full", b);
    expect(current().description).toBe(
      "Docs\n\n" +
        block(
          [
            '{"version":2}',
            '{"name":"full","bodyType":"text/plain","body":{"text":"b"}}',
            '{"name":"minimal","bodyType":"text/plain","body":{"text":"a"}}',
          ].join("\n"),
        ) +
        "\n",
    );
  });
});

describe("request-level operations", () => {
  test("saves into the request description, not the local store", async () => {
    const { ctx, stored, current } = fakeCtx({ description: "Docs" });
    const { replaced } = await saveVariant(ctx, current(), "minimal", a);
    expect(replaced).toBe(false);
    expect(stored.size).toBe(0);
    expect(current().description.startsWith("Docs\n\n")).toBe(true);
    expect(parseVariants(current().description)).toEqual({ minimal: a });
  });

  test("keeps every other request field intact", async () => {
    const { ctx, current, base } = fakeCtx();
    await saveVariant(ctx, base, "minimal", a);
    expect({ ...current(), description: "" }).toEqual({ ...base, description: "" });
  });

  test("reports a replace when saving under an existing name", async () => {
    const { ctx, current } = fakeCtx();
    await saveVariant(ctx, current(), "minimal", a);
    const { replaced } = await saveVariant(ctx, current(), "minimal", b);
    expect(replaced).toBe(true);
    expect(parseVariants(current().description)).toEqual({ minimal: b });
  });

  test("reads the freshest request, not the possibly stale argument", async () => {
    const { ctx, current, base } = fakeCtx();
    await saveVariant(ctx, base, "one", a);
    // `base` still has an empty description; the second save must not lose "one".
    await saveVariant(ctx, base, "two", b);
    expect(Object.keys(parseVariants(current().description)).sort()).toEqual(["one", "two"]);
  });

  test("deletes one variant and keeps the rest", async () => {
    const { ctx, current } = fakeCtx();
    await saveVariant(ctx, current(), "minimal", a);
    await saveVariant(ctx, current(), "full", b);
    expect(await deleteVariant(ctx, current(), "minimal")).toBe(true);
    expect(Object.keys(parseVariants(current().description))).toEqual(["full"]);
  });

  test("reports false for a name that was never saved", async () => {
    const { ctx, current } = fakeCtx();
    expect(await deleteVariant(ctx, current(), "minimal")).toBe(false);
  });

  test("loads variants from the freshest description, read-only", async () => {
    const { ctx, stored, current, base } = fakeCtx({ description: writeVariants("", { minimal: b }) });
    const { variants } = await loadVariants(ctx, { ...base, description: "" });
    expect(variants).toEqual({ minimal: b });
    expect(stored.size).toBe(0);
    expect(parseVariants(current().description)).toEqual({ minimal: b });
  });

  test("never writes over a corrupt block", async () => {
    const broken = "```" + BLOCK_TAG + "\n{ oops\n```";
    const { ctx, current } = fakeCtx({ description: broken });
    await expect(saveVariant(ctx, current(), "minimal", a)).rejects.toThrow(CorruptVariantsError);
    expect(current().description).toBe(broken);
  });
});
