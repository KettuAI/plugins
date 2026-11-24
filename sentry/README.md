Work with Sentry issues from Kettu.

What you get
- Mention an issue: type @ in the message box and pick an issue. The agent reads its facts and the stack trace of its latest event.
- References: a Sentry issue address in a reply is drawn as the issue, with its status and level, and shows its details when you point at it.
- Tools for agents: list unresolved issues of a project, read an issue with its latest stack trace, and resolve an issue. Kettu asks you before an agent uses them, as it does for any tool.
- A panel beside the session that lists unresolved issues, with a page for each issue and its stack trace.

Set it up
1. In Sentry, create an auth token with the scopes event:read and project:read, and event:write if agents may resolve issues.
2. Under Settings > Plugins > Sentry, paste the token, enter your organization's slug (acme in acme.sentry.io), and pick your data region. Optionally enter a project slug to limit the list to one project.

What it may do
It may reach sentry.io and its subdomains and nothing else, with your token. It adds to a message only the issues you mention. It cannot run commands or read your files.

Keep in mind
- Only Sentry's hosted service is supported, in the United States and European Union regions. A Sentry server you host yourself is not.
- It sees what your token sees. Issue cards are kept for a minute.
