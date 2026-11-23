import type { Context, HttpRequest, PluginDefinition } from "@yaakapp/api";
import { pickVariant } from "./picker";
import { CorruptVariantsError, deleteVariant, loadVariants, saveVariant } from "./variants";

type Handler = (ctx: Context, args: { httpRequest: HttpRequest }) => Promise<void>;

// A hand-edited, broken variants block must never be overwritten: report it
// and leave the request untouched so the user can repair it.
function guarded(handler: Handler): Handler {
  return async (ctx, args) => {
    try {
      await handler(ctx, args);
    } catch (err) {
      if (!(err instanceof CorruptVariantsError)) throw err;
      await ctx.toast.show({ color: "danger", icon: "alert_triangle", message: err.message });
    }
  };
}

export const plugin: PluginDefinition = {
  httpRequestActions: [
    {
      label: "Save Body as Variant",
      icon: "pin",
      onSelect: guarded(async (ctx, { httpRequest }) => {
        const { request, variants } = await loadVariants(ctx, httpRequest);
        const existing = Object.keys(variants);
        const rawName = await ctx.prompt.text({
          id: "body-variants.save",
          title: "Save Body as Variant",
          label: "Variant name",
          placeholder: "e.g. minimal, full-payload, invalid-email",
          description:
            existing.length > 0
              ? `Saving under an existing name updates it. Existing: ${existing.join(", ")}`
              : undefined,
          required: true,
        });
        const name = rawName?.trim();
        if (!name) return;

        const { replaced } = await saveVariant(ctx, request, name, {
          body: request.body,
          bodyType: request.bodyType,
        });
        await ctx.toast.show({
          color: "success",
          icon: "check",
          message: `${replaced ? "Updated" : "Saved"} body variant "${name}"`,
        });
      }),
    },
    {
      label: "Switch Body Variant",
      icon: "chevron_down",
      onSelect: guarded(async (ctx, { httpRequest }) => {
        const picked = await pickVariant(ctx, httpRequest, {
          id: "body-variants.switch",
          title: "Switch Body Variant",
          description:
            "Replaces the current body. Save it as a variant first if you want to keep it.",
        });
        if (picked == null) return;

        // Spread the whole (fresh) model: update() overwrites every column,
        // and the description holds the variants themselves.
        await ctx.httpRequest.update({
          ...picked.request,
          body: picked.snapshot.body,
          bodyType: picked.snapshot.bodyType,
        });
        await ctx.toast.show({
          color: "success",
          icon: "check",
          message: `Switched body to variant "${picked.name}"`,
        });
      }),
    },
    {
      label: "Send Body Variant",
      icon: "copy",
      onSelect: guarded(async (ctx, { httpRequest }) => {
        const picked = await pickVariant(ctx, httpRequest, {
          id: "body-variants.send",
          title: "Send Body Variant",
          description: "Switches the request to the chosen body, then sends it.",
        });
        if (picked == null) return;

        // Switch first so the editor always shows the body the response in
        // the history pane was produced by, then send that same model.
        const switched = {
          ...picked.request,
          body: picked.snapshot.body,
          bodyType: picked.snapshot.bodyType,
        };
        await ctx.httpRequest.update(switched);
        const response = await ctx.httpRequest.send({ httpRequest: switched });
        if (response.error != null) {
          await ctx.toast.show({
            color: "danger",
            icon: "alert_triangle",
            message: `Body variant "${picked.name}" failed: ${response.error}`,
          });
          return;
        }
        await ctx.toast.show({
          color: response.status < 400 ? "success" : "warning",
          icon: response.status < 400 ? "check" : "alert_triangle",
          message: `Sent body variant "${picked.name}" (HTTP ${response.status})`,
        });
      }),
    },
    {
      label: "Delete Body Variant",
      icon: "trash",
      onSelect: guarded(async (ctx, { httpRequest }) => {
        const picked = await pickVariant(ctx, httpRequest, {
          id: "body-variants.delete",
          title: "Delete Body Variant",
          description:
            "Deletes the saved snapshot. The request's current body is not affected.",
          confirmText: "Delete",
        });
        if (picked == null) return;

        await deleteVariant(ctx, picked.request, picked.name);
        await ctx.toast.show({
          color: "success",
          icon: "trash",
          message: `Deleted body variant "${picked.name}"`,
        });
      }),
    },
  ],
};
