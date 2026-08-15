---
description: Get PR ready to merge
---
Address PR comments with a code change if necessary. If a code change is not necessary or has been pushed, reply to the comment and mark it resolved. Resolve any conflicts and pull in main. Fix any CI failures on the latest commit.

When waiting for CI or review automation, use the command's watch mode with an appropriate tool timeout (for example, `gh pr checks --watch --interval 10`). Do not run multi-minute `sleep` commands. If manual polling is necessary, use short bounded waits and briefly report progress between polls.
