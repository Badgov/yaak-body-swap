import type { Context, HttpRequest } from "@yaakapp/api";

/**
 * A saved body is the opaque {body, bodyType} pair from the request model.
 * The shape of `body` depends on bodyType, so it is stored and restored
 * without interpretation. That is what keeps form and multipart bodies
 * working, not just text ones.
 */
export type BodySnapshot = {
  body: HttpRequest["body"];
  bodyType: HttpRequest["bodyType"];
};

export type VariantsByName = Record<string, BodySnapshot>;

/**
 * Variants are persisted inside the request's `description`, in a fenced
 * block tagged `yaak-body-swap`. The description is part of the request
 * model, so it travels with directory sync (the request's YAML file), Git,
 * and workspace export: variants are versioned and survive a machine change.
 *
 * `body` is not an option: the app rebuilds it from scratch when the body
 * type changes or a form editor saves, which would silently drop extra keys.
 */
export const BLOCK_TAG = "yaak-body-swap";
const FORMAT_VERSION = 1;

// Opening fence (3+ backticks) + tag, content, then the same fence on its own line.
const BLOCK_RE = new RegExp(
  "(^|\\n)[ \\t]*(`{3,})" + BLOCK_TAG + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\\2[ \\t]*(?=\\r?\\n|$)",
);

export class CorruptVariantsError extends Error {
  constructor(reason: string) {
    super(
      `The ${BLOCK_TAG} block in this request's description is not valid (${reason}). ` +
        "Fix or remove it in the Description tab; nothing was changed.",
    );
    this.name = "CorruptVariantsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extracts the variants stored in a description. Throws CorruptVariantsError on a broken block. */
export function parseVariants(description: string | null | undefined): VariantsByName {
  const match = BLOCK_RE.exec(description ?? "");
  if (match == null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[3] ?? "");
  } catch (err) {
    throw new CorruptVariantsError(err instanceof Error ? err.message : "invalid JSON");
  }
  if (!isRecord(parsed) || !isRecord(parsed.variants)) {
    throw new CorruptVariantsError('missing "variants" object');
  }

  const variants: VariantsByName = {};
  for (const [name, snapshot] of Object.entries(parsed.variants)) {
    if (!isRecord(snapshot) || !isRecord(snapshot.body)) {
      throw new CorruptVariantsError(`variant "${name}" has no body object`);
    }
    const bodyType = snapshot.bodyType;
    if (bodyType !== null && bodyType !== undefined && typeof bodyType !== "string") {
      throw new CorruptVariantsError(`variant "${name}" has an invalid bodyType`);
    }
    variants[name] = { body: snapshot.body, bodyType: bodyType ?? null };
  }
  return variants;
}

// Sorted keys at every level: saving the same content twice yields the same
// text, so Git diffs only show real changes.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function renderBlock(variants: VariantsByName): string {
  const json = JSON.stringify(sortKeys({ version: FORMAT_VERSION, variants }), null, 2);
  // The fence must be longer than any backtick run inside the content.
  const longestRun = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${BLOCK_TAG}\n${json}\n${fence}`;
}

/** Returns the description with the variants block replaced, appended, or (when empty) removed. */
export function writeVariants(description: string | null | undefined, variants: VariantsByName): string {
  const current = description ?? "";
  const hasVariants = Object.keys(variants).length > 0;
  const match = BLOCK_RE.exec(current);

  if (match == null) {
    if (!hasVariants) return current;
    const prefix = current.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${renderBlock(variants)}\n`;
  }

  const before = current.slice(0, match.index).trimEnd();
  const after = current.slice(match.index + match[0].length).trim();
  const parts = [before, hasVariants ? renderBlock(variants) : "", after].filter(Boolean);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Request-level operations
// ---------------------------------------------------------------------------

export type LoadedVariants = { request: HttpRequest; variants: VariantsByName };

/**
 * Loads the freshest copy of the request and its variants.
 *
 * Always continue with the returned `request`: it may carry a description
 * newer than the one the action was invoked with.
 *
 * There is no automatic migration from the original plugin: ctx.store is
 * scoped by plugin package name, so this fork cannot read the variants
 * `@sadick254/body-swap` kept there. See the README for the manual steps.
 */
export async function loadVariants(ctx: Context, httpRequest: HttpRequest): Promise<LoadedVariants> {
  const request = (await ctx.httpRequest.getById({ id: httpRequest.id })) ?? httpRequest;
  return { request, variants: parseVariants(request.description) };
}

async function persist(ctx: Context, request: HttpRequest, variants: VariantsByName): Promise<HttpRequest> {
  // Spread the whole model: update() args are deserialized with serde
  // defaults and every column is overwritten, so a bare partial would blank
  // the request's url, name, and workspace binding.
  const next = { ...request, description: writeVariants(request.description, variants) };
  return (await ctx.httpRequest.update(next)) ?? next;
}

export async function saveVariant(
  ctx: Context,
  httpRequest: HttpRequest,
  name: string,
  snapshot: BodySnapshot,
): Promise<{ replaced: boolean; request: HttpRequest }> {
  const { request, variants } = await loadVariants(ctx, httpRequest);
  const replaced = name in variants;
  variants[name] = snapshot;
  return { replaced, request: await persist(ctx, request, variants) };
}

export async function deleteVariant(
  ctx: Context,
  httpRequest: HttpRequest,
  name: string,
): Promise<boolean> {
  const { request, variants } = await loadVariants(ctx, httpRequest);
  if (!(name in variants)) return false;
  delete variants[name];
  await persist(ctx, request, variants);
  return true;
}
