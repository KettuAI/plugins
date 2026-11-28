Connect Kettu Bots to any self-hosted HTTP or WebSocket bridge using a small JSON protocol.

Use this plugin directly to integrate internal company IM tools, DingTalk, WeCom, Discord, Matrix, or custom automation servers — or fork it as a template for your own Kettu Bot channel plugin.

Protocol overview
- Health check: GET /health returning HTTP 200.
- WebSocket mode: connects to /ws with optional Authorization: Bearer <token>. Push JSON frames shaped like {"type":"inbound","id":"msg-1","chatId":"room-1","senderId":"u-1","senderLabel":"Alice","isDirect":true,"text":"@dev check CI"}. Replies are sent back as {"type":"reply","chatId":...,"threadId":...,"messageId":...,"botHandle":...,"title":...,"body":...,"status":...}.
- HTTP polling mode: polls GET /poll?cursor=<cursor> returning {"cursor":"...","messages":[...]}. Replies are posted to POST /reply.

What it may do
It uses the network.custom permission, which is strictly locked by Kettu to the exact endpoint origin you enter in the plugin settings — it can never contact any other host. It cannot read local files, run commands, or approve permission requests outside Kettu.
