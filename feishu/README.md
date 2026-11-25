Post the Kettu notices you pick to a Feishu or Lark group as message cards.

It uses a custom bot of the group, which only needs its webhook address. This plugin sends notices only: answering a request from Feishu would need a public address that a plugin on your computer cannot offer.

Set it up
1. In the Feishu or Lark group, add a custom bot and copy its webhook address, which starts with https://open.feishu.cn/ or https://open.larksuite.com/.
2. Paste it under Settings > Plugins > Feishu / Lark notifications. If you turned on signature verification for the bot, paste its secret too. If the bot requires a keyword, enter it.
3. On the plugin's page in Settings, choose which kinds of notices go to the group: permission requests, a turn that ended, errors, routines and plan limits. None go until you choose.
4. Use "Send a test card" in the Feishu / Lark view to check it.

What it may do
It may reach open.feishu.cn and open.larksuite.com and nothing else. It reads the words of your notices, such as a session's title and a short summary, and posts them to your group. It cannot answer requests, run commands or read your files.

Keep in mind
- Anyone who has the webhook address can post to the group, so it is kept in the system's key store and shown only as set or not set.
- A card shows plain text: nothing in a notice is read as Markdown or as an @ mention.
- The bot allows 5 requests a second and 100 a minute; the plugin spaces cards out to stay under it.
- The signature uses this computer's clock. If the bot answers 19021, check that the clock is right.

The Feishu / Lark logo belongs to its owner and is used here only to identify the service.
