# Body Swap

**Keep several named bodies on one request. Switch, send, done.**

![Body Swap in action](https://raw.githubusercontent.com/sadick254/yaak-body-swap/main/assets/demo.gif)

A [Yaak](https://yaak.app) plugin for everyone who tests the same endpoint
with more than one payload (the happy path, the missing field, the huge
one) and is tired of pasting bodies in and out of the editor or keeping a
graveyard of `Create user (copy 3)` requests in the sidebar.

A variant is a snapshot of the request's body *and* body type, stored
without interpreting its shape: JSON, GraphQL, form-encoded, and multipart
bodies all work.

## The four actions

Right-click a request in the sidebar, or open the command palette while the
request is active:

| Action | What it does |
| --- | --- |
| **Save Body as Variant** | Snapshots the current body under a name. Same name updates it. |
| **Switch Body Variant** | Puts the chosen body on the request. The plain Send button now sends it. |
| **Send Body Variant** | Switches to the chosen body, then sends it in one step. |
| **Delete Body Variant** | Removes a snapshot. Your current body is untouched. |

## A one-minute tour

1. Write a valid payload in the body editor → **Save Body as Variant** →
   name it `valid`.
2. Break it (remove a required field) → **Save Body as Variant** →
   `missing-email`.
3. **Send Body Variant** → pick `valid` → the request fires and the editor
   shows exactly the body that produced the response.
4. **Switch Body Variant** whenever you want a different body active
   without sending anything.

## Small things it gets right

- **The picker knows which variant is active.** Dialogs preselect the
  variant matching the request's current body: the one you last switched
  to. Confirm without touching the select and it acts on that one.
- **The editor never lies.** Sending a variant switches to it first, so the
  body on screen is always the body behind the newest response.
- **Every body type.** Snapshots are opaque: multipart and form bodies
  survive the round trip exactly like JSON.
- **Templates keep working.** Variants store your `${[ ... ]}` tags
  unrendered; they render with the active environment at send time, like
  any other body.

## Install

This fork is not in the plugin registry. Install from source:

```sh
npx --yes @yaakapp/cli plugin build
```

then Settings → Plugins → Add Plugin → choose this directory.

## Where variants live (fork change)

> Fork of [sadick254/yaak-body-swap](https://github.com/sadick254/yaak-body-swap).
> The original keeps variants in Yaak's local plugin store, so they never
> leave the machine. This fork stores them **inside the request itself**.

Variants are written to the request's **Description** as a fenced block:

````markdown
Your own notes stay here, untouched.

```yaak-body-swap
{
  "variants": {
    "minimal": {
      "body": { "text": "{\"email\":\"a@b.c\"}" },
      "bodyType": "application/json"
    }
  },
  "version": 1
}
```
````

Because the description is part of the request model:

- **Directory sync / Git:** variants land in the request's
  `yaak.<requestId>.yaml`, so they are versioned, diffable, and available on
  any machine that pulls the repo.
- **Export / import:** they travel with workspace exports.
- **Deleting a request deletes its variants.** Nothing is left behind.
- **Deterministic output:** names and keys are sorted, so re-saving the same
  content produces no diff.

Notes:

- The block is visible in the request's Description tab. Write your own docs
  above or below it; the plugin only rewrites the block. It is removed when
  the last variant is deleted.
- If the block is hand-edited into invalid JSON, every action refuses to
  write and shows an error instead of overwriting it.
- **Migration:** variants saved by v1.x in the local plugin store are moved
  into the description automatically the first time you use any action on
  that request (on a name clash, the description wins).
- Bodies are stored as-is (unrendered `${[ ... ]}` tags included). Do not
  save variants containing secrets if the workspace is pushed to a shared
  repo; use environment variables for those.
- Re-importing a spec (OpenAPI etc.) still creates requests with fresh ids
  and empty descriptions.
- Switching replaces the request's current body by design. If the current
  body matters, save it as a variant first. The switch dialog reminds you.

## Development

Node 24 is required by the plugin bundler (`.nvmrc` included). Note that
`npx yaak` resolves to an unrelated npm package. Always use
`npx --yes @yaakapp/cli`.

```sh
npm install
npx vitest run                        # tests
npx tsc --noEmit                      # typecheck
npx --yes @yaakapp/cli plugin dev     # rebuild + reload into Yaak on save
```

Without `plugin dev`, a statically installed plugin does not reliably pick
up rebuilds. Restart Yaak or toggle the plugin off and on after building.
