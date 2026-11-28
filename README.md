# Kettu plugins

Plugins for [Kettu](https://github.com/KettuAI/Kettu). A plugin is a folder that adds to Kettu what one service needs: notices to your phone or group chat, issues you can mention in a message, tools for your agents, panels beside a session. You install it once and every agent you use gets it.

These are published to the Kettu Marketplace by `kettu-labs`. In Kettu, open Marketplace and find them under Plugins. Every plugin lists what it may do, including the websites it may reach, before you install it, and asks again when an update wants more.

| Plugin                                 | What it does                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ntfy](ntfy/README.md)                 | Sends the Kettu notices you pick to an ntfy topic on ntfy.sh, and lets you allow or deny a permission request with the buttons on the notification.               |
| [Feishu / Lark](feishu/README.md)      | Posts the Kettu notices you pick to a Feishu or Lark group as message cards, through a custom bot, with signature verification.                                  |
| [Linear](linear/README.md)             | Mention Linear issues, see them as references in replies, let agents search, read, create and comment on issues, and list the issues assigned to you.            |
| [Sentry](sentry/README.md)             | Mention Sentry issues, see them as references in replies, let agents list, read and resolve issues, and browse unresolved issues beside the session.              |
| [Telegram Bot](telegram-bot/README.md) | Bidirectional Telegram Bot channel for Kettu Bots over direct long polling — no public webhook or cloud relay needed.                                             |
| [Feishu / Lark Bot](feishu-bot/README.md) | Bidirectional Feishu / Lark Bot channel for Kettu Bots over the official WebSocket long connection with Interactive Card 2.0 replies.                          |
| [GitHub Bot](github-bot/README.md)     | Receives `@kettu-bots` mentions on GitHub Issues and PRs over Kettu Cloud Connector and posts replies back according to each Bot's policy.                        |
| [Custom Bridge](custom-bridge/README.md) | Reference Bot channel plugin using `network.custom` to connect Kettu Bots to any self-hosted HTTP or WebSocket gateway.                                        |

## Writing one

1. Make a folder named for the plugin, in lowercase, with `plugin.json` at its top and a short `README.md` beside it. The README is shown as plain text on the listing's page, so leave out Markdown syntax.
2. In `plugin.json` use the Agent Plugins format and put Kettu's part under `extensions["sh.kettu"]`: `format: 1`, the script (`./sh.kettu/main.js`), `api: 1`, the settings, tools, views and the rest it declares, and `permissions`. Ask only for what the plugin uses, and name the narrowest websites under `network:`. Give every title and description in English and in `zh-CN`.
3. Write the script as one JavaScript file that talks to Kettu through the global `kettu`. It runs in a sandbox with no files, no commands and no network of its own: only the calls its permissions allow. The sandbox has no `URL`, `TextEncoder`, `btoa` or `crypto`, so a plugin builds addresses and encodings itself; for secrets such as one-time tokens it asks Kettu with `random.bytes`. Start the file with `// @ts-check`.
4. Check it against the plugin API's types with `npm run typecheck`, TypeScript installed. `types/index.d.ts` is a copy of `packages/plugin-api/index.d.ts` from the [Kettu repository](https://github.com/KettuAI/Kettu/tree/main/packages/plugin-api), which is under the MIT license; copy it again when the API adds calls.
5. Test it with `node:test` against a fake `kettu`, as the tests in `test/` do: they need no dependencies and no account, and run with `npm test`.
6. Check it in Kettu: ask an agent to run `marketplace_check` on the folder, or choose Publish › From a folder in Marketplace › Published, and try it from Installed › Add from folder.
7. Open a pull request with the folder.

## License

MIT, see [LICENSE](LICENSE).
