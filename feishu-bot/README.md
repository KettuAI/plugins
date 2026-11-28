Connect Kettu Bots to Feishu or Lark using the official WebSocket long connection directly from your computer.

Configure one Feishu or Lark app once and share it across all of your Kettu Bots. Private messages go to your default Bot, or you can start any message with @handle or /handle to address a specific Bot. Replies are delivered as Interactive Card 2.0 Markdown cards with automatic plain-text fallback.

Set it up
1. Create a self-built app in the Feishu or Lark Open Platform, enable Bot capability, subscribe to im.message.receive_v1, and choose Receive events via persistent connection (WebSocket).
2. Open Settings > Plugins > Feishu / Lark Bot, select Feishu or Lark, and enter your App ID and App Secret.
3. Open any Bot in Kettu, go to Channels, turn on Feishu / Lark, and choose a default Bot.
4. Click Generate pairing code in Kettu and send /pair <code> to the app in Feishu or Lark to bind your owner account.

What it may do
It may only connect to Feishu and Lark endpoints and bridge messages to Kettu Bots. It cannot read local files, run commands, or approve permission requests from chat: approvals always happen inside Kettu Desktop or Mobile.

The Feishu and Lark names and logos belong to their owner and are used here only to identify the service.
