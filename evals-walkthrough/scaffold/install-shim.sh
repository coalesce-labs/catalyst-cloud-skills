#!/bin/sh
# Puts a `catalyst-skills` on PATH that runs whichever stand-in CLI the current HOME holds, so the
# guide's own `catalyst-skills ...` commands reach the case's state during an eval run. Run once on
# the machine that runs the suite (the sandbox), before `claude plugin eval`.
set -eu
target=${1:-/usr/local/bin/catalyst-skills}
cat > "$target" <<'SHIM'
#!/bin/sh
cli="$HOME/.catalyst-onboard-eval/catalyst-skills.mjs"
[ -f "$cli" ] || { echo "catalyst-skills: no stand-in CLI under $HOME; this shim is for eval runs only" >&2; exit 127; }
exec node "$cli" "$@"
SHIM
chmod 755 "$target"
echo "shim written to $target"

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
