Connect Kettu Bots to Telegram over direct long polling from your computer.

Configure one Telegram Bot token once and share it across all of your Kettu Bots. Send a direct message to talk to your default Bot, or prefix any message with @handle or /handle to route directly to a specific Bot. Group messages are isolated per thread and only trigger when the bot is mentioned or replied to.

Set it up
1. Create a bot with @BotFather on Telegram and copy its Bot Token.
2. Open Settings > Plugins > Telegram Bot and paste the token. It is stored in the system key store.
3. Open any Bot in Kettu, go to Channels, turn on Telegram, and choose a default Bot.
4. Click Generate pairing code in Kettu and send /pair <code> to your Telegram bot to bind your owner account.

What it may do
It may only reach api.telegram.org over HTTPS and bridge normalized messages to Kettu Bots. It cannot read your local files, run shell commands, or approve permission requests from Telegram: high-risk approvals always happen inside Kettu Desktop or Mobile.

The Telegram name and logo belong to their owner and are used here only to identify the service.
