#!/bin/sh
# Puts a `catalyst` on PATH that runs whichever stand-in CLI the current HOME holds, so the
# guide's own `catalyst ...` commands reach the case's state during an eval run. Run once on
# the machine that runs the suite (the sandbox), before `claude plugin eval`.
set -eu
target=${1:-/usr/local/bin/catalyst}
node_bin=$(command -v node)
cat > "$target" <<SHIM
#!/bin/sh
cli="\$HOME/.catalyst-onboard-eval/catalyst.mjs"
[ -f "\$cli" ] || { echo "catalyst: no stand-in CLI under \$HOME; this shim is for eval runs only" >&2; exit 127; }
exec "$node_bin" "\$cli" "\$@"
SHIM
chmod 755 "$target"
echo "shim written to $target"
# The old name beside it: a guide reply that still says `catalyst-skills` runs to completion and is failed by
# the does-not-say-the-old-name grader, instead of dying on command-not-found before the other graders see it.
old_target=$(dirname "$target")/catalyst-skills
cp "$target" "$old_target" && chmod 755 "$old_target"
echo "old-name alias written to $old_target"

# An `npx` in front of the real one: the skill's scripts fall back to `npx @catalyst-cloud/catalyst-skills`
# when no credential is stored (the nothing-connected state), and a sandbox has no network for npm.
real_npx=$(command -v npx || true)
npx_target=$(dirname "$target")/npx
cat > "$npx_target" <<SHIM
#!/bin/sh
case "\$1" in
  @catalyst-cloud/catalyst-skills|@catalyst-cloud/catalyst-skills@*|@catalyst-cloud/cli|@catalyst-cloud/cli@*) shift; exec "$target" "\$@" ;;
esac
exec "$real_npx" "\$@"
SHIM
chmod 755 "$npx_target"
echo "npx interceptor written to $npx_target (forwards everything else to $real_npx)"
