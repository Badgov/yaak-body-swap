import type { Context, HttpRequest, HttpResponse, JsonPrimitive } from "@yaakapp/api";
import { describe, expect, test } from "vitest";
import { plugin } from "./index";
import { BLOCK_TAG, parseVariants, writeVariants } from "./variants";

type FormValues = { [key: string]: JsonPrimitive } | null;

// Carries the fields a real request has beyond the body pair: the update()
// assertions rely on them to tell "full model" apart from a bare partial.
const request = {
  id: "req_1",
  workspaceId: "wk_1",
  folderId: null,
  name: "Create user",
  method: "POST",
  url: "https://api.example.com/users",
  description: "Creates a user.",
  headers: [{ name: "X-Trace", value: "1", enabled: true }],
  body: { text: '{"email":"a@b.c"}' },
  bodyType: "application/json",
} as unknown as HttpRequest;

function fakeCtx(
  prompts: { text?: string | null; form?: FormValues } = {},
  response: Partial<HttpResponse> = { status: 200, error: null },
  seed: Partial<HttpRequest> = {},
) {
  const stored = new Map<string, unknown>();
  const toasts: Array<{ message: string }> = [];
  const updates: HttpRequest[] = [];
  const sends: Array<{ httpRequest: Partial<HttpRequest> }> = [];
  const formCalls: unknown[] = [];
  // The app's request table: getById() reads it, update() overwrites a row.
  const requests = new Map<string, HttpRequest>([[request.id, { ...request, ...seed }]]);
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
    toast: {
      async show(toast: { message: string }) {
        toasts.push(toast);
      },
    },
    prompt: {
      async text() {
        return prompts.text ?? null;
      },
      async form(args: unknown) {
        formCalls.push(args);
        return prompts.form ?? null;
      },
    },
    httpRequest: {
      async getById({ id }: { id: string }) {
        return requests.get(id) ?? null;
      },
      async update(args: HttpRequest) {
        updates.push(args);
        requests.set(args.id, args);
        return args;
      },
      async send(args: { httpRequest: Partial<HttpRequest> }) {
        sends.push(args);
        return response as HttpResponse;
      },
    },
  } as unknown as Context;
  const current = () => requests.get(request.id) as HttpRequest;
  return { ctx, toasts, updates, sends, formCalls, current };
}

function action(label: string) {
  const found = plugin.httpRequestActions?.find((a) => a.label === label);
  if (!found) throw new Error(`no action labeled "${label}"`);
  return found;
}

type Variants = Parameters<typeof writeVariants>[1];
const withVariants = (variants: Variants) => ({
  description: writeVariants(request.description, variants),
});
const variantsOf = (r: HttpRequest) => parseVariants(r.description);

describe("Save Body as Variant", () => {
  test("snapshots the current body into the request description", async () => {
    const { ctx, toasts, current } = fakeCtx({ text: "minimal" });
    await action("Save Body as Variant").onSelect(ctx, { httpRequest: request });
    expect(variantsOf(current())).toEqual({
      minimal: { body: { text: '{"email":"a@b.c"}' }, bodyType: "application/json" },
    });
    // The user's own docs stay on top; everything but the description is untouched.
    expect(current().description.startsWith("Creates a user.\n\n```" + BLOCK_TAG)).toBe(true);
    expect({ ...current(), description: request.description }).toEqual(request);
    expect(toasts[0]?.message).toContain('Saved body variant "minimal"');
  });

  test("snapshots the freshest body, not the stale action argument", async () => {
    const { ctx, current } = fakeCtx({ text: "edited" }, undefined, { body: { text: "new" } });
    await action("Save Body as Variant").onSelect(ctx, { httpRequest: request });
    expect(variantsOf(current()).edited?.body).toEqual({ text: "new" });
  });

  test("does nothing when the prompt is cancelled", async () => {
    const { ctx, toasts, updates } = fakeCtx({ text: null });
    await action("Save Body as Variant").onSelect(ctx, { httpRequest: request });
    expect(updates).toEqual([]);
    expect(toasts).toEqual([]);
  });

  test("refuses to touch a corrupt variants block", async () => {
    const broken = "```" + BLOCK_TAG + "\n{ oops\n```";
    const { ctx, toasts, updates } = fakeCtx({ text: "x" }, undefined, { description: broken });
    await action("Save Body as Variant").onSelect(ctx, { httpRequest: request });
    expect(updates).toEqual([]);
    expect(toasts[0]?.message).toContain("not valid");
  });
});

describe("Switch Body Variant", () => {
  test("writes the whole request back with the chosen snapshot", async () => {
    const seed = withVariants({ empty: { body: { text: "{}" }, bodyType: "application/json" } });
    const { ctx, updates } = fakeCtx({ form: { variant: "empty" } }, undefined, seed);
    await action("Switch Body Variant").onSelect(ctx, { httpRequest: request });
    // The full model matters: the app deserializes update() args with serde
    // defaults and overwrites every column, so a partial blanks the request.
    // The description (holding the variants) must survive the switch.
    expect(updates).toEqual([
      { ...request, ...seed, body: { text: "{}" }, bodyType: "application/json" },
    ]);
  });

  test("preselects the variant matching the current body", async () => {
    const seed = withVariants({
      aaa: { body: { text: "other" }, bodyType: "text/plain" },
      zzz: { body: request.body, bodyType: request.bodyType },
    });
    const { ctx, updates, formCalls } = fakeCtx({ form: {} }, undefined, seed);
    await action("Switch Body Variant").onSelect(ctx, { httpRequest: request });

    const form = formCalls[0] as { inputs: Array<{ defaultValue?: string }> };
    expect(form.inputs[0]?.defaultValue).toBe("zzz");
    // The untouched confirm resolves to the matching variant, not "aaa".
    expect(updates).toEqual([{ ...request, ...seed }]);
  });

  test("treats an untouched dialog as picking the preselected first variant", async () => {
    // The app's form dialog only records inputs the user touches: it renders
    // the select's defaultValue but returns {} when confirmed as-is.
    const seed = withVariants({
      "b-full": { body: { text: "b" }, bodyType: "text/plain" },
      "a-min": { body: { text: "a" }, bodyType: "text/plain" },
    });
    const { ctx, updates } = fakeCtx({ form: {} }, undefined, seed);
    await action("Switch Body Variant").onSelect(ctx, { httpRequest: request });
    expect(updates).toEqual([{ ...request, ...seed, body: { text: "a" }, bodyType: "text/plain" }]);
  });

  test("toasts instead of prompting when nothing is saved", async () => {
    const { ctx, toasts, updates, formCalls } = fakeCtx();
    await action("Switch Body Variant").onSelect(ctx, { httpRequest: request });
    expect(toasts[0]?.message).toContain("No body variants");
    expect(formCalls).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("does nothing when the dialog is cancelled", async () => {
    const seed = withVariants({ empty: { body: { text: "{}" }, bodyType: "application/json" } });
    const { ctx, updates } = fakeCtx({ form: null }, undefined, seed);
    await action("Switch Body Variant").onSelect(ctx, { httpRequest: request });
    expect(updates).toEqual([]);
  });
});

describe("Send Body Variant", () => {
  const seed = withVariants({ empty: { body: { text: "{}" }, bodyType: "application/json" } });

  test("switches the request to the chosen body and sends it", async () => {
    const { ctx, sends, updates, toasts } = fakeCtx({ form: { variant: "empty" } }, undefined, seed);
    await action("Send Body Variant").onSelect(ctx, { httpRequest: request });
    const switched = { ...request, ...seed, body: { text: "{}" }, bodyType: "application/json" };
    expect(updates).toEqual([switched]);
    expect(sends).toEqual([{ httpRequest: switched }]);
    expect(toasts[0]?.message).toBe('Sent body variant "empty" (HTTP 200)');
  });

  test("reports a transport error instead of a status", async () => {
    const { ctx, toasts } = fakeCtx(
      { form: { variant: "empty" } },
      { status: 0, error: "dns lookup failed" },
      seed,
    );
    await action("Send Body Variant").onSelect(ctx, { httpRequest: request });
    expect(toasts[0]?.message).toBe('Body variant "empty" failed: dns lookup failed');
  });

  test("toasts instead of prompting when nothing is saved", async () => {
    const { ctx, toasts, sends, formCalls } = fakeCtx();
    await action("Send Body Variant").onSelect(ctx, { httpRequest: request });
    expect(toasts[0]?.message).toContain("No body variants");
    expect(formCalls).toEqual([]);
    expect(sends).toEqual([]);
  });

  test("does nothing when the dialog is cancelled", async () => {
    const { ctx, sends } = fakeCtx({ form: null }, undefined, seed);
    await action("Send Body Variant").onSelect(ctx, { httpRequest: request });
    expect(sends).toEqual([]);
  });
});

describe("Delete Body Variant", () => {
  const seed = withVariants({
    empty: { body: { text: "{}" }, bodyType: "application/json" },
    full: { body: { text: "{...}" }, bodyType: "application/json" },
  });

  test("removes the chosen snapshot and leaves the body alone", async () => {
    const { ctx, toasts, current } = fakeCtx({ form: { variant: "empty" } }, undefined, seed);
    await action("Delete Body Variant").onSelect(ctx, { httpRequest: request });
    expect(Object.keys(variantsOf(current()))).toEqual(["full"]);
    expect(current().body).toEqual(request.body);
    expect(toasts[0]?.message).toBe('Deleted body variant "empty"');
  });

  test("does nothing when the dialog is cancelled", async () => {
    const { ctx, toasts, updates } = fakeCtx({ form: null }, undefined, seed);
    await action("Delete Body Variant").onSelect(ctx, { httpRequest: request });
    expect(updates).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
