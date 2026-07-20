# pi-discord-chat

A minimal [pi](https://github.com/earendil-works/pi) extension for chatting with a pi coding-agent session from
a Discord thread.

Start `pi` in a project folder as usual, run `/chat-connect` once, and a Discord thread appears — everything you
send there reaches that same pi session, and replies come back into the thread. Reconnecting the same session
(`pi --continue`, restart after a crash, etc.) reuses the same thread automatically. Tool calls show up as a
single concise, emoji-tagged status line that's edited in place while the turn runs, then replaced by the final
reply — no big blocks per tool call.

This is a deliberately stripped-down alternative to [pi-chat](https://github.com/earendil-works/pi-chat): no Gondolin
VM sandboxing, no cross-channel memory files, no skills, Discord only, one thread per session (not one bot
watching a channel for everyone), and configuration is a plain JSON file instead of a guided setup. Tool calls
run directly on the host running the session — see **Security** below.

## 1. Create a Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application** → name it whatever you like.
2. Note the **Application ID** on the General Information page — you'll need it as `botUserId` below (for
   Discord bots the application ID and the bot's own user ID are the same value).
3. **Bot** tab → **Reset Token** → copy it. This is `botToken`. Keep it secret.
4. Still on the **Bot** tab, enable **Message Content Intent** under Privileged Gateway Intents.
5. **OAuth2** tab → **URL Generator** → scopes `bot` and `applications.commands`, permissions: View Channels, Send
   Messages, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads. Open the
   generated URL and invite the bot to your server. (`applications.commands` is required for the `/model`,
   `/compact`, `/clear`, `/stop`, `/status` slash commands below — if you invited the bot before this scope existed,
   re-run the URL generator with both scopes checked and re-authorize; no need to kick the bot first.)
6. In Discord, enable **Developer Mode** (User Settings → Advanced) so you can right-click a channel and
   **Copy Channel ID** — that's `parentChannelId`, the channel new session threads get created in.

## 2. Install the extension

```
pi install /path/to/pi-discord-chat -l
```

(`-l` for a local/dev install so edits take effect without reinstalling.)

## 3. Write the config file

Create `~/.pi/discord-chat/config.json`:

```jsonc
{
	"accounts": {
		"default": {
			"botToken": "the-bot-token-from-step-1.3",
			"botUserId": "the-application-id-from-step-1.2",
			"parentChannelId": "the-channel-id-from-step-1.6",

			// Everything below is optional.
			"serverName": "My Server",              // cosmetic, shown to the model
			"threadAutoArchiveMinutes": 1440,        // default 1440 (24h)
			"access": {
				"allowedUserIds": ["your-discord-user-id"],
				"allowedRoleIds": [],
				"ignoreBots": true                     // default true
			}
		}
	}
}
```

`accounts` is a map, so you can define more than one bot/config (e.g. `"work"`, `"personal"`) and pick one with
`/chat-connect <accountId>`. The file is validated on load — a missing required field names the account and
field so you can fix it.

## 4. Connect

In a project folder:

```
/chat-connect
```

Creates a Discord thread (named after the folder) under `parentChannelId` and binds this pi session to it. From
then on, every message in that thread is sent to the agent — no @mention needed. Reconnecting the same pi
session later reuses the same thread; a brand-new session (not `--continue`/`--session`) creates a new one.

## Commands

- `/chat-connect [accountId]` — bind this session to a thread (creates one on first connect, reused after).
- `/chat-status` / `/chat-disconnect` — status / disconnect for this session.

Inside the thread, both Discord slash commands and plain text control the running turn:

| Slash command | Plain text | Effect |
|---|---|---|
| `/stop` | `stop` | Abort the current turn |
| `/clear` | `clear` (or `new`) | Clear the conversation context so pi starts fresh in this thread |
| `/compact [instructions]` | `compact [instructions]` | Compact context, optionally focused by instructions |
| `/status` | `status` | Report model, queue, and connection status |
| `/model <name>` | `model <name>` | Switch the pi model for this thread |

`/clear` hides everything older than the moment you sent it from the model, rather than starting a new pi
session — pi only lets slash commands typed in its own terminal do that, not extension event handlers. The
thread log and the pi session file keep the full history; only what gets sent to the LLM is trimmed. Run
`/chat-new` in pi's terminal if you want a genuinely new session bound to the same thread.

Plain text must match exactly (`model claude-sonnet-4-5`, not "switch to claude" or "/model" with no name) —
anything else is sent to the agent as a normal chat message instead. Slash commands are more forgiving since
Discord validates the shape for you, and avoid a mobile-client quirk where a `/`-prefixed message that doesn't
resolve to a real slash command can silently fail to send. Slash commands are registered per-server the first
time a thread in that server connects; if they don't show up, re-invite the bot with the `applications.commands`
scope (see step 1 above).

## Security

There is no VM boundary. `bash`/`read`/`write`/`edit` run as whatever OS user the pi process runs as, scoped by
convention (not enforcement) to the thread's working directory — an absolute path or `../` in a tool call can
still reach anywhere that user can. Anyone who can post in the thread can get the agent to run arbitrary shell
commands as that user.

- Set `access.allowedUserIds` / `access.allowedRoleIds` in the config to restrict who can trigger it — worth
  doing even for a "private" thread, since anyone added to it (or with channel access, if it's not
  archived/locked) can post.
- `chat_attach` is restricted to files inside the thread's working directory, so a compromised turn can't
  exfiltrate arbitrary host files as a Discord attachment — but reads/writes/bash are not similarly restricted.
- `write`/`edit`/`bash` are blocked from touching anything under `~/.pi` (pi's own config, sessions, and
  credentials), so a chat turn can't rewrite the default model/provider or other global settings as a side
  effect of a natural-language request — use `/model`, `/compact`, `/clear`, `/stop` for those instead.
- `config.json` contains a live bot token in plaintext; treat it like any other credential file.
