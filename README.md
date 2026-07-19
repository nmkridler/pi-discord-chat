# pi-discord-chat

A minimal [pi](https://github.com/badlogic/pi-mono) extension for chatting with a pi coding-agent session from
a Discord thread.

Start `pi` in a project folder as usual, run `/chat-connect` once, and a Discord thread appears — everything you
send there reaches that same pi session, and replies come back into the thread. Reconnecting the same session
(`pi --continue`, restart after a crash, etc.) reuses the same thread automatically. Tool calls show up as a
single concise, emoji-tagged status line that's edited in place while the turn runs, then replaced by the final
reply — no big blocks per tool call.

This is a deliberately stripped-down alternative to [pi-chat](https://github.com/badlogic/pi-chat): no Gondolin
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
5. **OAuth2** tab → **URL Generator** → scope `bot`, permissions: View Channels, Send Messages, Attach Files,
   Read Message History, Create Public Threads, Send Messages in Threads. Open the generated URL and invite the
   bot to your server.
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

Inside the thread, plain text controls the running turn: `stop` aborts, `new` starts a fresh pi session bound to
the same thread, `compact` compacts context, `status` reports usage.

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
- `config.json` contains a live bot token in plaintext; treat it like any other credential file.
