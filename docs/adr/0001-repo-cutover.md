# The rewrite takes the crm-chat name

GitHub cannot keep two repos named `nickcomua/crm-chat`. Rename the old repo to `nickcomua/crm-chat-legacy` and move its local checkout to `~/Documents/crm-chat-legacy`. Keep that checkout, including its uncommitted work. Create a new public `nickcomua/crm-chat` at `~/Documents/crm-chat` with empty history. The new repo forbids direct pushes to `main`. A GitHub ruleset blocks everyone, including admins. `main` moves only by pull-request merge. The legacy repo does not get this rule. Archive `crm-chat-legacy` as soon as the new repo exists, before either shell has booted, then make that archived repo private.

The old checkout stays because the refactor needs it as a reference. Deleting it was proposed and then rejected. A new name, importing history, waiting to archive until boot, and leaving the archived repo public were rejected.
