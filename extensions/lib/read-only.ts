const gitPrefix = "git --no-pager --no-optional-locks -c core.fsmonitor=false";
const lsOptions = new Set(["--all", "--almost-all", "--human-readable", "--directory", "--color=never"]);
const gitOptions: Record<string, Set<string>> = {
  status: new Set(["-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]),
  log: new Set(["--oneline", "--stat", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv"]),
  diff: new Set(["--cached", "--staged", "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--check", "--patch", "-p", "--quiet", "--exit-code", "--no-ext-diff", "--no-textconv"]),
};

function validArgs(args: string[], options: Set<string>, command: string): boolean {
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (paths) continue;
    if (arg === "--") { paths = true; continue; }
    if (!arg.startsWith("-") || options.has(arg)) continue;
    if (command === "ls" && /^-[alhd]+$/.test(arg)) continue;
    if (command === "log") {
      if (/^(?:-\d+|--max-count=\d+)$/.test(arg)) continue;
      if (arg === "-n" && /^\d+$/.test(args[i + 1] ?? "")) { i++; continue; }
    }
    return false;
  }
  return true;
}

/** A deliberately small single-command grammar, not a general Shell classifier. */
export function readOnlyBash(command: unknown): string | undefined {
  if (typeof command !== "string" || /[\r\n]/.test(command)) return;
  const tokens = command.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/);
  // No quoting, expansion, redirection, operators, comments or non-ASCII tokens.
  if (tokens.some((token) => !/^[A-Za-z0-9_./:@%+,=-]+(?:~\d+)?$/.test(token))) return;
  const [name, ...args] = tokens;
  if (name === "pwd") {
    if (!args.length || (args.length === 1 && ["-L", "-P"].includes(args[0]))) return tokens.join(" ");
    return;
  }
  if (name === "ls") return validArgs(args, lsOptions, name) ? tokens.join(" ") : undefined;
  if (name !== "git") return;

  const gitArgs = tokens.slice(tokens.slice(0, 5).join(" ") === gitPrefix ? 5 : 1);
  const [subcommand, ...options] = gitArgs;
  if (!["status", "log", "diff"].includes(subcommand) || !validArgs(options, gitOptions[subcommand], subcommand)) return;
  // Prevent optional index refresh and fsmonitor/external diff/textconv callbacks.
  const guarded = subcommand === "status" || (options[0] === "--no-ext-diff" && options[1] === "--no-textconv")
    ? options : ["--no-ext-diff", "--no-textconv", ...options];
  return `${gitPrefix} ${[subcommand, ...guarded].join(" ")}`;
}
