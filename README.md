# save-then-compact

A Claude Code plugin that makes Claude **save its handover notes before the conversation is compacted**.

Compaction shrinks a long session into a summary. Details that lived only in the conversation (running jobs, the exact next step, what the user just asked for) can get lost. This plugin holds the compaction until Claude has written them down.

## What it does

- **Manual `/compact`:** the compaction is held. Claude is asked to update its handover notes and to reply with a one-time code (`SAVED stc-…`). The compaction runs only after that reply arrives and, if a handover file is set, only after that file has actually been written.
- **Automatic, at a size you choose (default 400,000 tokens):** the same save-then-compact flow starts by itself at the end of a turn.
- **Claude Code's own emergency compaction** (at the very edge of the context window) still runs as normal, with no room left for a save turn, but it gets extra instructions telling the summary what to keep.
- **Safe fallbacks:** if the save isn't confirmed within 3 turns or 20 minutes, nothing is compacted and the plugin backs off for 30 minutes.

Commands:

- `/compact-now [instructions]`: compact right away, skipping the save step.
- `/save-compact-status`: show what the plugin is doing, the current context size and the handover file.

## Install

At the prompt of a terminal session:

```
/plugin install save-then-compact --marketplace holzmanshmuel/claude-save-then-compact
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session).

From a shell:

```
claude plugin install save-then-compact --marketplace holzmanshmuel/claude-save-then-compact
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `holzmanshmuel/claude-save-then-compact`, then Add plugin.

## Settings (optional environment variables)

| Variable | What it does |
| --- | --- |
| `SAVE_COMPACT_AT_TOKENS` | Start the automatic flow at this many context tokens. Default `400000`, minimum `50000`. |
| `SAVE_COMPACT_HANDOVER_FILE` | Absolute path of the notes file Claude must update. When set, a `SAVED` reply only counts if this file was written after the request. |
| `SAVE_COMPACT_LANES_DIR` | For setups with one notes file per workstream: an absolute folder holding dated folders (`YYYY-MM-DD/`), each with `<CLAUDE_LANE>.md`. When `CLAUDE_LANE` is set, the newest matching file is used. |

With no handover file set, Claude saves wherever the project keeps its notes, and the one-time code alone confirms the save.

The automatic threshold works best when Claude Code's own auto-compaction is set to fire later than it (for example a large `autoCompactWindow`), so the save turn has room.

## How it works

The plugin hooks `session.compact` (to hold a manual compaction), `turn.complete` (to watch for the `SAVED` code and the size threshold) and `session.start` (to register the two commands). It keeps one small state value per session. It reads only the handover file's metadata (to check it was written) and the folder listing in `SAVE_COMPACT_LANES_DIR`. It makes no network calls.

## Uninstall

```
/plugin uninstall save-then-compact
```

## License

MIT
