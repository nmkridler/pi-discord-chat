#!/usr/bin/env python3
"""PreToolUse hook for Bash: block `find` and any recursive/unscoped `grep`.

Rationale: perilla-qa's `ask` should be the default way to search and
understand this codebase (see CLAUDE.md). `find` is essentially never
needed since `ask` covers discovery. `grep -r`/`-R` is a tree crawl no
matter what path it's pointed at, so it's blocked outright -- reach for
`ask` instead. Plain `grep` against one explicit file stays allowed,
since that's how you inspect a specific file `ask` hasn't indexed
(e.g. config/capability files), not how you search the codebase.

Exit 0 = allow, exit 1 = block (message goes to stdout for blockMessage).
"""
import json
import sys

import re
import shlex

# grep flags that consume the following token as a value (unless attached,
# e.g. -A3), so it must not be misread as a path/pattern.
_VALUE_FLAGS = {"-e", "-f", "-A", "-B", "-C", "-m", "--after-context",
                "--before-context", "--context", "--max-count", "--regexp",
                "--file"}
_BROAD_PATHS = {".", "..", "/", "./", "*"}


def split_pipeline(command):
    """Split on top-level |, &&, ;, || (not inside quotes)."""
    segments = []
    current = ""
    quote = None
    i = 0
    while i < len(command):
        c = command[i]
        if quote:
            current += c
            if c == quote:
                quote = None
        elif c in ("'", '"'):
            quote = c
            current += c
        elif c == "|" and command[i:i + 2] != "||":
            segments.append(current)
            current = ""
        elif command[i:i + 2] in ("&&", "||") or (c == ";"):
            segments.append(current)
            current = ""
            i += 1 if c == ";" else 2
            continue
        else:
            current += c
        i += 1
    segments.append(current)
    return segments


def is_grep_invocation(tokens):
    for tok in tokens:
        if "=" in tok and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            continue  # leading env var assignment, e.g. FOO=bar grep ...
        base = tok.rsplit("/", 1)[-1]
        return base in ("grep", "egrep", "fgrep")
    return False


def is_find_invocation(tokens):
    for tok in tokens:
        if "=" in tok and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            continue
        base = tok.rsplit("/", 1)[-1]
        return base == "find"
    return False


def grep_is_broad(tokens):
    """True if this grep call has no explicit file/dir scope, or recurses
    from the repo root / cwd without narrowing."""
    recursive = False
    positionals = []
    skip_next = False
    started = False
    for tok in tokens:
        if not started:
            # skip leading env assignments and the grep binary itself
            if "=" in tok and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
                continue
            started = True
            continue
        if skip_next:
            skip_next = False
            continue
        if tok in _VALUE_FLAGS:
            skip_next = True
            continue
        if tok.startswith("--"):
            if tok in ("--recursive", "--recursive=yes"):
                recursive = True
            continue
        if tok.startswith("-") and tok != "-":
            if any(c in tok for c in ("r", "R")):
                recursive = True
            continue
        positionals.append(tok)

    if recursive:
        # -r/-R is always a tree crawl, however it's scoped — use ask instead.
        return "recursive"

    # first positional is the pattern unless -e/-f supplied it (already
    # consumed above); remaining positionals are paths
    paths = positionals[1:] if positionals else []

    if not paths:
        # No explicit path: fine only if this segment reads from a pipe
        # (handled by caller), otherwise it's an unscoped search.
        return "no-path"
    return False


def evaluate(command):
    """Return a block reason string, or None if the command is allowed."""
    segments = split_pipeline(command)
    for idx, seg in enumerate(segments):
        seg = seg.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            continue
        if not tokens:
            continue

        if is_find_invocation(tokens):
            return "find blocked — use mcp__perilla-qa__ask instead"

        if is_grep_invocation(tokens):
            receives_stdin = idx > 0  # preceded by a pipe
            verdict = grep_is_broad(tokens)
            if verdict == "no-path" and receives_stdin:
                continue  # grep filtering piped output is fine
            if verdict == "recursive":
                return (
                    "recursive grep (-r/-R) blocked — use mcp__perilla-qa__ask "
                    "instead for tree-wide search; grep is only for a single "
                    "known file (files ask may not index)"
                )
            if verdict:
                return (
                    "unscoped grep blocked — use mcp__perilla-qa__ask instead, "
                    "or scope grep to an explicit file (files ask may not index)"
                )
    return None


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(0)
    command = payload.get("tool_input", {}).get("command", "") or payload.get("command", "")
    if not command:
        sys.exit(0)

    reason = evaluate(command)
    if reason:
        print(reason)
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()