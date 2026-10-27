import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations, getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";

function fileInfo(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Match the path forms accepted by Pi's built-in write/edit tools.
function inputPath(input: string, cwd: string): string {
  let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (process.platform === "win32" && !value.includes("\\")) {
    value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_match, drive: string, rest = "") => `${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`);
  }
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    value = resolve(homedir(), value.slice(2));
  }
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return resolve(cwd, value);
}

export function canonicalPath(input: string, cwd: string): string {
  const target = inputPath(input, cwd);
  let current = target;
  const missing: string[] = [];
  while (!fileInfo(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`无法解析路径：${input}`);
    missing.unshift(basename(current));
    current = parent;
  }
  // A dangling symlink must fail closed, not be mistaken for a new local file.
  return resolve(realpathSync(current), ...missing);
}

export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function gitProtectedPaths(cwd: string): string[] {
  const project = realpathSync(cwd);
  let entry: string | undefined;
  for (let directory = project; ; directory = dirname(directory)) {
    const candidate = resolve(directory, ".git");
    const stat = fileInfo(candidate);
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error("Auto 不支持符号链接形式的 .git 入口；请显式申请提权");
      entry = candidate;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  // Discover the repository on disk, not a repository selected by inherited GIT_* variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", project, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
    encoding: "utf8", timeout: 5000, env: { ...env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" },
  });
  if (result.error) throw new Error(`无法发现 Git 保护路径；请安装 Git 2.31+：${result.error.message}`);
  if (result.status !== 0) {
    if (result.status === 128 && result.stderr.startsWith("fatal: not a git repository")) {
      if (!entry) return [];
      // Keep a non-repository .git directory protected without blocking ordinary work.
      if (fileInfo(entry)?.isDirectory()) return [entry];
    }
    throw new Error(`无法发现 Git 保护路径：${result.stderr.trim()}`);
  }
  const paths = result.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  if (paths.length !== 2 || paths.some((path) => !isAbsolute(path))) {
    throw new Error("Git 返回了无法解析的元数据路径");
  }
  const protectedPaths = paths.map((path) => realpathSync(path));
  if (entry) protectedPaths.push(entry);
  return [...new Set(protectedPaths)].sort((a, b) => a.length - b.length);
}

export function isAutoWritePath(path: string, cwd: string): boolean {
  const target = canonicalPath(path, cwd);
  const project = realpathSync(cwd);
  const temp = realpathSync(tmpdir());
  if (!isWithin(project, target) && !isWithin(temp, target)) return false;
  const stat = fileInfo(target);
  if (stat?.isFile() && stat.nlink > 1) return false;
  const requested = inputPath(path, project);
  return !gitProtectedPaths(cwd).some((root) => isWithin(root, requested) || isWithin(root, target));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function sandboxCommand(command: string, cwd: string): string {
  if (process.platform !== "linux") throw new Error("Auto Bash 沙箱仅支持 Linux/WSL；不会自动降级为无沙箱执行");
  const probe = spawnSync("bwrap", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (probe.error || probe.status !== 0) {
    throw new Error("Auto Bash 沙箱需要可运行的 bubblewrap (bwrap)；请安装并启用 user namespaces，或显式申请提权");
  }
  const shell = getShellConfig();
  if (basename(shell.shell) !== "bash") throw new Error("Auto Bash 沙箱需要安装 Bash");
  const project = realpathSync(cwd);
  const writable = [...new Set([project, realpathSync(tmpdir())])].sort((a, b) => a.length - b.length);
  const args = [
    "bwrap", "--die-with-parent", "--unshare-all", "--share-net", "--new-session",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--chdir", project,
  ];
  for (const root of writable) args.push("--bind", root, root);
  // Mount protection last so a writable project or temporary root cannot cover it.
  for (const root of gitProtectedPaths(project)) args.push("--ro-bind", root, root);
  args.push("--", shell.shell, ...shell.args, command);
  return `exec ${args.map(shellQuote).join(" ")}`;
}

export function createSandboxOperations(): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec(command, cwd, options) {
      return local.exec(sandboxCommand(command, cwd), cwd, {
        ...options,
        env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      });
    },
  };
}
