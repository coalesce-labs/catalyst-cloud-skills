# @catalyst-cloud/catalyst-skills (deprecated name)

This package is now [`@catalyst-cloud/cli`](https://www.npmjs.com/package/@catalyst-cloud/cli), and its command is `catalyst`.

This name still publishes so that machines which update it keep getting new releases. Each release of this package depends on exactly the same version of `@catalyst-cloud/cli`. It gives you two commands:

- `catalyst`, the command.
- `catalyst-skills`, the old name. It runs `catalyst` with the same arguments and adds one line on stderr saying the name is deprecated.

To move to the new name, remove this package first, then install the new one:

```sh
npm uninstall -g @catalyst-cloud/catalyst-skills
npm install -g @catalyst-cloud/cli
```

Removing it first matters. Both packages provide the `catalyst` and `catalyst-skills` commands, and npm refuses to install one over the other's commands.

## Known issue: another program called `catalyst`

This package installs a `catalyst` command into npm's global bin directory. If that directory already holds a `catalyst` that npm did not install for this package, npm refuses the whole install with `EEXIST`, and the machine stays on the release it had. Remove or rename the other file, then install again.

If the other `catalyst` lives in a directory earlier on your PATH, the install succeeds but `catalyst` runs the other program. `catalyst-skills ready` says so. Keep using `catalyst-skills` on that machine until it is sorted out.
