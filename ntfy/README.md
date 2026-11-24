Send the Kettu notices you pick to ntfy, and answer permission requests from the notification.

ntfy (ntfy.sh) pushes a message to your phone or desktop without an account. This plugin posts the notices you choose to one topic, and you subscribe to that topic in the ntfy app.

Set it up
1. Install the plugin. It makes a long random topic for you; open ntfy in the side panel to see it, or set your own under Settings > Plugins > ntfy.
2. In the ntfy app, subscribe to that topic on ntfy.sh.
3. On the plugin's page in Settings, choose which kinds of notices go to the ntfy topic: permission requests, a turn that ended, errors, routines and plan limits. None go until you choose.
4. Use "Send a test notice" in the ntfy view to check it.

Answer from the notification
A permission request that waits for you comes with two buttons, Allow once and Deny. Tapping one posts your answer to a second, separate topic that only this notification names. The plugin reads that topic while the request waits and answers it in Kettu, which shows the answer as given from ntfy. Each button carries a secret that works once for that one request, and anything posted without it is ignored. Questions and plans are never answered this way, and neither is "always allow".

What it may do
It may reach ntfy.sh and nothing else. It reads the words of your notices, such as a session's title, and, for permission requests, the command or files they ask for, and it sends them to ntfy.sh. It can answer a permission request you chose to send to it. It does not run commands and cannot read your files.

Keep in mind
- ntfy topics have no password: anyone who knows your topic can read your notices, and anyone who has a notification's buttons can answer that one request. Keep the topic long and private, or protect it on ntfy.sh and add an access token in the settings.
- The Allow and Deny buttons post to the reply topic without your token.
- While a request waits the plugin checks the reply topic every few seconds, and less often after five minutes. It stops once the request is answered or after half an hour.
- Only ntfy.sh is supported, not a server of your own.
