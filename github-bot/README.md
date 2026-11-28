Connect Kettu Bots to GitHub Issues and Pull Requests through Kettu Cloud Connector or a self-hosted connector.

When you mention @kettu-bots on an Issue or Pull Request, the connector verifies your GitHub identity and forwards the trigger over an outbound WebSocket directly to your online computer. Your code, diffs, and prompts never persist on the connector server.

Set it up
1. Sign in to your Kettu account in Settings > Account and link your GitHub account on the Kettu Connectors page.
2. Install the Kettu GitHub App on the repositories you want to allow.
3. Open any Bot in Kettu, go to Channels, turn on GitHub, optionally restrict repository scopes (owner/repo), and pick a public reply policy (Review in Kettu first, Auto reply, or Kettu only).
4. Comment @kettu-bots <handle> <task> on an Issue or PR to trigger that Bot.

What it may do
It may read your Kettu Cloud Connector session token, connect to connectors.kettu.sh (or the custom connector URL you explicitly configure), and bridge GitHub mention deliveries to Kettu Bots.

The GitHub name and logo belong to their owner and are used here only to identify the service.
