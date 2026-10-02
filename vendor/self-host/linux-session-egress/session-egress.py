#!/usr/bin/env python3
"""Own and prove the self-host session network's egress policy (CTC-4415, for CTC-4266).

A self-hosted supervisor on a native Linux engine is not-ready until it reads a fresh attestation
that an nftables forward chain drops private ranges from its session bridge (`host.session-egress`,
apps/host-agent/src/supervisor/network.ts). The supervisor runs unprivileged and cannot read
nftables, so this root helper does the work and writes the proof:

  converge  make sure catalyst-session-v1 exists with the reviewed shape, install the forward and
            input chains in its own table, then attest (the boot service).
  attest    prove both chains and the network still match, and rewrite the attestation (the 5-minute
            timer). Any mismatch removes the old attestation, so the host goes not-ready at once.

Modeled on apps/host-provision/infra/ensure-research-network.py and egress-policy.py
(research-egress-v1), with the same drop list. It owns ONE nftables table, inet catalyst_session,
and never touches another table, so it is safe on a box with its own firewall.
"""
import json, os, subprocess, sys, tempfile, time

NAME = "catalyst-session-v1"
# Linux interface names are limited to 15 visible bytes.
BRIDGE = "catalyst-sess0"
LABEL_KEY = "dev.catalystcloud.session-network"
LABEL_VALUE = "v1"
# Inter-container traffic is off: a phase cannot reach another tenant's container on the bridge.
OPTIONS = {"com.docker.network.bridge.name": BRIDGE, "com.docker.network.bridge.enable_icc": "false"}
ENFORCEMENT = "nftables-docker-forward-v1"
TABLE = "catalyst_session"
CHAIN = "session_egress"
# CTC-4415 P1 (Codex, #8870): a session's traffic to the bridge gateway, or to any address the host
# holds, is delivered locally and traverses INPUT, never FORWARD. A dedicated host drops it with its
# own default-drop input chain (host-provision's render.ts). An arbitrary self-host box may accept
# everything there, so this table owns an input chain too.
INPUT_CHAIN = "session_input"
DEFAULT_ATTESTATION = "/var/lib/catalyst/session-egress/attestation.json"
# The gateway, RFC 1918, CGNAT, loopback, link-local, benchmarking, multicast and reserved ranges:
# the research-egress-v1 list, kept equal by apps/host-agent/test/session-egress-producer.test.ts.
IPV4 = [('0.0.0.0', 8), ('10.0.0.0', 8), ('100.64.0.0', 10), ('127.0.0.0', 8), ('169.254.0.0', 16), ('172.16.0.0', 12), ('192.0.0.0', 24), ('192.168.0.0', 16), ('198.18.0.0', 15), ('224.0.0.0', 4), ('240.0.0.0', 4)]
IPV6 = [('::1', 128), ('fc00::', 7), ('fe80::', 10), ('ff00::', 8)]


class Refusal(RuntimeError):
    pass


def run(argv, stdin=None):
    try:
        return subprocess.run(
            argv,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/var/empty", "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal(os.path.basename(argv[0]) + "_unavailable") from error


# ---------------------------------------------------------------------------------------------
# The network.

def inspect(docker):
    result = run([docker, "network", "inspect", NAME])
    if result.returncode != 0:
        # Docker 29 prints [] for a missing network; Docker 28 prints nothing.
        missing = f"Error response from daemon: network {NAME} not found"
        if result.stdout.strip() not in ("", "[]") or result.stderr.strip() != missing:
            raise Refusal("network_inspection_failed")
        return None
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Refusal("network_inspection_invalid") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise Refusal("network_inspection_invalid")
    return value[0]


def matches(network):
    """The keys the supervisor verifies (sessionNetworkShape), plus this helper's own bridge name,
    which its chains are bound to. Required keys only: an operator's extra option (an MTU) or an
    unrelated label is kept, as the supervisor keeps it (CTC-4415 P2, Codex #8870), never removed
    with the network. No subnet is pinned: Docker picks a free one, and a customer box may already
    use research-egress-v1's 172.30.0.0/24."""
    if not isinstance(network, dict):
        return False
    options = network.get("Options")
    labels = network.get("Labels")
    return (
        network.get("Name") == NAME
        and network.get("Driver") == "bridge"
        and network.get("Internal") is False
        and network.get("EnableIPv6") is False
        and network.get("Ingress") is False
        and network.get("ConfigOnly", False) is False
        and isinstance(options, dict)
        and all(options.get(key) == value for key, value in OPTIONS.items())
        and isinstance(labels, dict)
        and labels.get(LABEL_KEY) == LABEL_VALUE
        and isinstance(network.get("Containers"), dict)
    )


def create(docker):
    result = run(
        [
            docker,
            "network",
            "create",
            "--driver=bridge",
            *["--opt=" + key + "=" + value for key, value in OPTIONS.items()],
            "--label=" + LABEL_KEY + "=" + LABEL_VALUE,
            NAME,
        ]
    )
    if result.returncode != 0 or result.stdout.strip() == "":
        raise Refusal("network_create_failed")
    if not matches(inspect(docker)):
        raise Refusal("network_create_mismatch")


def ensure_network(docker):
    network = inspect(docker)
    if network is None:
        create(docker)
        return "created"
    if matches(network):
        return "unchanged"
    containers = network.get("Containers")
    if not isinstance(containers, dict):
        raise Refusal("network_inspection_invalid")
    # ⛔ Never under a running phase: removing it would cut that phase off mid-session.
    if containers:
        raise Refusal("network_attached")
    if run([docker, "network", "rm", NAME]).returncode != 0:
        raise Refusal("network_remove_failed")
    create(docker)
    return "replaced"


# ---------------------------------------------------------------------------------------------
# The chain.

def ruleset():
    """One atomic transaction: declare the table (a no-op when present), delete it, and add it back
    whole, so a re-run replaces both chains exactly and never duplicates a rule."""
    rules = [f' iifname "{BRIDGE}" ip daddr {addr}/{length} counter drop' for addr, length in IPV4]
    rules += [f' iifname "{BRIDGE}" ip6 daddr {addr}/{length} counter drop' for addr, length in IPV6]
    return (
        f"table inet {TABLE} {{}}\n"
        f"delete table inet {TABLE}\n"
        f"table inet {TABLE} {{\n"
        f" chain {CHAIN} {{\n"
        # Ahead of Docker's own forward rules (priority 0). A drop in any base chain is final.
        " type filter hook forward priority -10; policy accept;\n"
        + "\n".join(rules)
        + "\n }\n"
        f" chain {INPUT_CHAIN} {{\n"
        # Nothing on the host is a session's to reach: only replies to connections the host itself
        # opened pass. Public egress is forwarded, and a container's DNS resolver (127.0.0.11) lives
        # in the container's own namespace, so neither needs INPUT.
        " type filter hook input priority -10; policy accept;\n"
        f' iifname "{BRIDGE}" ct state established,related accept\n'
        f' iifname "{BRIDGE}" counter drop\n'
        " }\n}\n"
    )


def apply_chain(nft):
    if run([nft, "-f", "-"], stdin=ruleset()).returncode != 0:
        raise Refusal("chain_apply_failed")


def chain_matches(nft):
    """Both chains, exactly as `ruleset()` installs them, read back from nft itself. A missing or
    drifted forward OR input chain is a mismatch, so `attest` withdraws the attestation."""
    result = run([nft, "-j", "list", "table", "inet", TABLE])
    if result.returncode != 0:
        return False
    try:
        entries = json.loads(result.stdout)["nftables"]
        chains = {e["chain"]["name"]: e["chain"] for e in entries if "chain" in e}
        rules = {}
        for e in entries:
            if "rule" in e:
                rules.setdefault(e["rule"].get("chain"), []).append(e["rule"])
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError):
        return False
    if set(chains) != {CHAIN, INPUT_CHAIN}:
        return False
    for name, hook in ((CHAIN, "forward"), (INPUT_CHAIN, "input")):
        want = {"family": "inet", "table": TABLE, "type": "filter", "hook": hook, "prio": -10, "policy": "accept"}
        if any(chains[name].get(k) != v for k, v in want.items()):
            return False

    def match(protocol, right):
        return {"match": {"op": "==", "left": {"payload": {"protocol": protocol, "field": "daddr"}}, "right": right}}

    interface = {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": BRIDGE}}

    # nft JSON serializes a full-width CIDR as a scalar, unlike shorter prefixes.
    def prefix(address, length):
        return address if length in (32, 128) else {"prefix": {"addr": address, "len": length}}

    forward = [[interface, match("ip", prefix(a, n)), {"counter": None}, {"drop": None}] for a, n in IPV4]
    forward += [[interface, match("ip6", prefix(a, n)), {"counter": None}, {"drop": None}] for a, n in IPV6]
    established = {"match": {"op": "in", "left": {"ct": {"key": "state"}}, "right": ["established", "related"]}}
    local = [[interface, established, {"accept": None}], [interface, {"counter": None}, {"drop": None}]]

    def canonical(expr):
        return [{"counter": None} if isinstance(item, dict) and set(item) == {"counter"} else item for item in expr]

    def exactly(found, expected):
        return len(found) == len(expected) and all(
            canonical(rule.get("expr", [])) == want
            and set(rule).issubset({"family", "table", "chain", "handle", "expr", "comment"})
            for rule, want in zip(found, expected)
        )

    return exactly(rules.get(CHAIN, []), forward) and exactly(rules.get(INPUT_CHAIN, []), local)


# ---------------------------------------------------------------------------------------------
# The attestation (read by the supervisor's checkEgressAttestation).

def withdraw(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def attest(docker, nft, path):
    try:
        if not chain_matches(nft):
            raise Refusal("chain_mismatch")
        if not matches(inspect(docker)):
            raise Refusal("network_mismatch")
    except Refusal:
        # A stale proof would keep the host placeable for up to 15 minutes after the policy is gone.
        withdraw(path)
        raise
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o755, exist_ok=True)
    body = json.dumps(
        {"version": 1, "enforcement": ENFORCEMENT, "bridge": BRIDGE, "verifiedAtMs": int(time.time() * 1000)}
    )
    handle, temporary = tempfile.mkstemp(prefix=".attestation.", dir=directory)
    try:
        with os.fdopen(handle, "w") as out:
            out.write(body + "\n")
        # The supervisor (uid 10001) reads it through a read-only mount.
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        withdraw(temporary)
        raise
    return "attested"


def converge(docker, nft, path):
    try:
        outcome = ensure_network(docker)
        apply_chain(nft)
    except Refusal:
        withdraw(path)
        raise
    attest(docker, nft, path)
    return outcome


def main(argv):
    if not argv or argv[0] not in ("converge", "attest"):
        raise Refusal("invalid_arguments")
    options = {"docker": "/usr/bin/docker", "nft": "/usr/sbin/nft", "attestation": DEFAULT_ATTESTATION}
    for arg in argv[1:]:
        key, _, value = arg.partition("=")
        if not key.startswith("--") or key[2:] not in options or value == "":
            raise Refusal("invalid_arguments")
        options[key[2:]] = value
    action = converge if argv[0] == "converge" else attest
    return action(options["docker"], options["nft"], options["attestation"])


if __name__ == "__main__":
    try:
        print(main(sys.argv[1:]))
    except Refusal as error:
        print("catalyst_session_egress_" + str(error), file=sys.stderr)
        raise SystemExit(1)
