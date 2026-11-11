# dsh-delete-conversation

English | [简体中文](README.zh.md)

A DSH (host runtime) plugin that adds a **Delete conversation** action to every
conversation in the Web UI sidebar — and actually removes the conversation's
local data, which DSH itself provides no way to do.

## Why this plugin exists

DSH deliberately ships **no** conversation-deletion capability. Every relevant
package documents that pruning is out-of-band maintenance:

| Package | Stated limitation |
|---|---|
| `dsh-session-persistence` | "No deletion or retention API" |
| `dsh-session-persistence-jsonl` | "Nothing deletes session files" |
| `dsh-client-ui-workspace` | "No Session deletion — archived but never deleted" |
| `dsh-session-projection-cache` | "No eviction or retention surface" |

So conversations accumulate forever. This plugin implements the missing
operation once, on the Host, and exposes it to the Web UI over an authenticated
route.

## What gets deleted

Clicking **Delete conversation** opens a confirmation dialog that first lists
everything that would be removed. Nothing is deleted until you confirm.

### 1. Local conversation cache — removed automatically

| Artifact | Location |
|---|---|
| Session log | `$DSH_HOME/sessions/--<project>--/<id>/session.v4.jsonl.zstd` |
| Historical log generations | same directory (`session.jsonl`, `session.v1…vN`) |
| Projection cache | `$DSH_HOME/storages/session_projcache/sessions/<id>.json` |
| Spill files | `<tmp>/dsh-spill-*/session-<sha256(id)[:12]>/` |
| Workspace membership | `workspace.json` → `sessionIds`, `archivedSessionIds`, `pinnedSessionIds` |

### 2. Produced files — opt-in, per file

The `present` tool records deliverable paths in durable
`deliverables/presented` session events. This plugin reads those events **before
the log is deleted** (the log is their only record) and offers the files for
deletion with individual checkboxes.

Files are **never** deleted unless you tick them.

## Safety model

Deletion is real and irreversible, so the plugin is deliberately conservative:

- **Two-phase protocol.** `inspect` is read-only and returns the full plan;
  `delete` requires the exact confirmed path list.
- **Path allowlist.** Only paths returned by the same `inspect` call are
  accepted. A forged or stale path is rejected.
- **Session id validation.** Ids must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`,
  so `../` and absolute-path traversal never reach the filesystem.
- **Content-addressed caches untouched.** Attachment objects under
  `attachments/v1/objects/` are shared between sessions and forks; they are
  never deleted.
- **DSH-owned directories are protected.** `sessions`, `storages`,
  `attachments`, `cache`, `plugins` and `profiles` can never be treated as a
  produced file.
- **Outside-workspace files are kept.** A delivered path outside the
  conversation's own working directory is almost always a shared asset (a
  skill, a tool, a library). These are listed as *not deleted* and are not
  offered for removal.
- **Running work is stopped first** through DSH's own
  `archiveSession({ stopActivity: true })` seam, so no live write handle is
  left appending to a deleted log.

## Install

```powershell
# From the DSH Web UI: Settings → Plugins → add a local directory
# or point Plugin Manager at this checkout:
plugin_manager install_bundle "E:\path\to\dsh-delete-conversation"
```

The bundle declares its patch in `cordis.patch.yml`:

```yaml
- insert:
    - id: delete-conversation
      name: '@local/dsh-delete-conversation'
```

Then **restart the host runtime**. A newly installed bundle needs a fresh
Loader composition before its browser half can register a UI slot.

## Usage

1. Open any conversation list in the left sidebar.
2. Hover a conversation row and click **…**
3. Choose **Delete conversation** (last row in the menu).
4. Review the list of local cache files.
5. Optionally tick the produced files you want removed.
6. Press **Delete conversation**.

## Internationalization

Copy ships in **Chinese and English**. Both dictionaries register through the
Client locale service, so the menu row and dialog follow the active language
without a reload.

## Layout

| File | Role |
|---|---|
| `index.js` | Host half: deletion logic, log decoding, and the authenticated `/api/dsh-delete-conversation/rpc` route |
| `client.js` | Browser half: the sidebar menu row and the confirmation dialog |
| `cordis.patch.yml` | Loader patch inserting the plugin row |
| `package.json` | Manifest: bundle patch + `dsh.client` declaration |
| `locale/*.json` | Plugin Manager title and description |
| `icon.svg` | Plugin Manager artwork |

## Design notes

- **The session log is the source of truth.** Produced-file paths live only in
  `deliverables/presented` events, so they are read before the log is removed.
- **Concatenated zstd frames.** DSH writes one independent zstd frame per
  append batch. The decoder splits on the frame magic `28 b5 2f fd` and
  decompresses each frame separately.
- **`encodeSegment` is reproduced faithfully.** Session directories are the
  injected id encoded to one safe path segment — most ids happen to start with
  `session-`, but some are bare UUIDs, so the name is computed, never assumed.
- **Plain-JS host route, not Typert Remote.** The generated `ctx.remote.*`
  namespaces are build artifacts; a plain-JS bundle cannot extend them. The
  Host registers an authenticated `connection.fetch` route instead, the same
  pattern shipped DSH plugins use.
- **Theme-native UI.** The dialog styles from `--dsw-alias-*` tokens only, so it
  matches light and dark themes.

## Verification status

| Layer | Status |
|---|---|
| Host deletion logic | ✅ Verified against real session data (log, projection cache and spill lookup all match) |
| Destructive flow | ✅ Verified end-to-end in an isolated sandbox HOME |
| Input hardening | ✅ Malformed session id, unconfirmed path and unknown op all rejected |
| Browser rendering | ⚠️ Requires a host restart to load; visually unverified in this checkout |

## Attribution

**Attribution is mandatory.** Any use, copy, modification or redistribution of
this project — in whole or in part, in source or binary form, including as part
of a larger work — must retain and display the following credit:

> dsh-delete-conversation by **weapon111**
> https://github.com/weapon111/dsh-delete-conversation

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the binding terms.

## License

MIT with a mandatory attribution requirement — see [LICENSE](LICENSE).
