import {
  createBashTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSandboxOperations, isAutoWritePath } from "./lib/sandbox.ts";
import { readOnlyBash } from "./lib/read-only.ts";

type PermissionMode = "default" | "auto" | "yolo";

interface BashParams {
  command: string;
  timeout?: number;
}

interface PermissionState {
  mode?: PermissionMode;
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Default",
  auto: "Auto",
  yolo: "YOLO",
};

async function approve(
  ctx: ExtensionContext,
  title: string,
  detail: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || signal?.aborted) return false;
  const options = signal ? { signal } : undefined;
  const choice = await ctx.ui.select(`${title}\n\n${detail}`, ["Allow once", "Deny"], options);
  return choice === "Allow once" && !signal?.aborted;
}

export default function simplePermissions(pi: ExtensionAPI): void {
  let mode: PermissionMode = "auto";

  pi.events.on("pi-dev-kit:approve-document-write", (data) => {
    const request = data as {
      ctx: ExtensionContext;
      path: string;
      action: "write" | "delete";
      signal?: AbortSignal;
      respond: (decision: Promise<boolean>) => void;
    };
    request.respond((async () => {
      if (request.signal?.aborted) return false;
      if (mode === "yolo" || (mode === "auto" && isAutoWritePath(request.path, request.ctx.cwd))) return true;
      return approve(request.ctx, `${MODE_LABELS[mode]} permission request`, `${request.action}: ${request.path}`, request.signal);
    })());
  });

  function updateStatus(ctx: ExtensionContext): void {
    let color: "accent" | "muted" | "warning" = "muted";
    if (mode === "auto") color = "accent";
    if (mode === "yolo") color = "warning";

    ctx.ui.setStatus(
      "simple-permissions",
      ctx.ui.theme.fg(color, `Permission: ${MODE_LABELS[mode]}`),
    );
  }

  function setMode(next: PermissionMode, ctx: ExtensionContext): void {
    mode = next;
    pi.appendEntry("simple-permissions", { mode });
    updateStatus(ctx);
    ctx.ui.notify(`Permission mode: ${MODE_LABELS[mode]}`, mode === "yolo" ? "warning" : "info");
  }

  async function chooseMode(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const choice = await ctx.ui.select("Permission mode", ["Default", "Auto", "YOLO"]);
    if (choice) setMode(choice.toLowerCase() as PermissionMode, ctx);
  }

  pi.registerCommand("permission", {
    description: "Show or switch permission mode: /permission [default|auto|yolo]",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value) {
        await chooseMode(ctx);
        return;
      }
      if (value !== "default" && value !== "auto" && value !== "yolo") {
        ctx.ui.notify("Usage: /permission [default|auto|yolo]", "warning");
        return;
      }
      setMode(value as PermissionMode, ctx);
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Cycle Permission mode (Default -> Auto -> YOLO)",
    handler: async (ctx) => {
      const nextMap: Record<PermissionMode, PermissionMode> = {
        default: "auto",
        auto: "yolo",
        yolo: "default",
      };
      setMode(nextMap[mode], ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const entry = ctx.sessionManager.getBranch()
      .filter((item) => item.type === "custom" && item.customType === "simple-permissions")
      .pop() as { data?: PermissionState } | undefined;
    const savedMode = entry?.data?.mode;
    mode = (savedMode === "default" || savedMode === "auto" || savedMode === "yolo")
      ? savedMode
      : "auto";
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event) => {
    let boundaryText = "";
    if (mode === "yolo") {
      boundaryText = "\n\n## Permission boundary\n\nThe active permission mode is YOLO. There are no restrictions. You have full system access without manual approval.";
    } else {
      boundaryText = `\n\n## Permission boundary\n\nThe active permission mode is ${MODE_LABELS[mode]}. Network access and network-search tools are allowed in every mode.\n\nAuto: bash always runs inside a Linux/WSL filesystem sandbox without approval. The current working directory and system temporary directory are writable; the current repository's Git metadata and .git entry are read-only. Use bash for normal calls, including read-only commands, network access, Python/uv, tests, and complex shell syntax. Use bash_escalated only for necessary writes outside those writable roots or to protected Git metadata; provide the restricted path and necessary operation. Default/Auto require user approval for bash_escalated. Approval removes the entire sandbox for that call, not just protection on the declared path. This does not police every Git command or other repositories, and is not an adversarial security sandbox.\n\nDefault: Controlled writes and Bash commands outside the shared read-only whitelist require approval. Only accepted simple pwd, basic ls, and supported git status/log/diff forms run without approval; quoting, operators, substitutions, redirection, scripts, and unknown options require approval in Default.\n\nPlan restrictions apply independently in every permission mode. In Default and Plan, recognized Git inspection disables optional locks, fsmonitor, external diff and textconv.`;
    }
    return { systemPrompt: `${event.systemPrompt}${boundaryText}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    const callMode = mode;
    if (callMode === "yolo") return;
    if (event.toolName === "bash" || event.toolName === "bash_escalated") {
      const owner = pi.getCommands().find((command) => command.name === "permission" && command.source === "extension")?.sourceInfo;
      const bash = pi.getAllTools().find((tool) => tool.name === event.toolName);
      if (!owner || !bash || bash.sourceInfo.path !== owner.path || bash.sourceInfo.source !== owner.source) {
        return { block: true, reason: "受控 bash 已被其他扩展覆盖；Default/Auto 模式拒绝执行" };
      }
      return;
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const tool = pi.getAllTools().find((item) => item.name === event.toolName);
    if (tool?.sourceInfo.source !== "builtin") {
      return { block: true, reason: "受控写入工具已被其他扩展覆盖；Default/Auto 模式拒绝执行" };
    }
    const path = String(event.input.path ?? "");
    const needsApproval = callMode === "default" || !isAutoWritePath(path, ctx.cwd);
    if (!needsApproval) return;

    const allowed = await approve(
      ctx,
      `${MODE_LABELS[callMode]} permission request`,
      `${event.toolName}: ${path}`,
      ctx.signal,
    );
    if (!allowed) {
      return {
        block: true,
        reason: ctx.signal?.aborted
          ? "Operation aborted"
          : ctx.hasUI
            ? "Blocked by user"
            : "Permission required, but no interactive UI is available",
      };
    }
  });

  const template = createBashTool(process.cwd());
  const bashParameters = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  }, { additionalProperties: false });

  pi.registerTool({
    ...template,
    name: "bash",
    label: "bash (permissioned)",
    executionMode: "sequential",
    parameters: bashParameters,
    description: `${template.description}\n\nAuto: Always runs inside the filesystem sandbox without approval; only the current working directory and system temporary directory are writable, and current repository Git metadata is read-only. Use this tool for read-only commands, network access, Python/uv, tests, and complex shell commands. For necessary writes across that boundary, use bash_escalated. Default: Only shared read-only whitelist commands run without approval; other commands require approval. YOLO runs without sandbox or approval. Plan restrictions apply independently.`,
    async execute(toolCallId, params: BashParams, signal, onUpdate, ctx) {
      const callMode = mode;
      const inspection = callMode === "default" ? readOnlyBash(params.command) : undefined;
      if (callMode === "default" && !inspection) {
        const allowed = await approve(ctx, "Default bash permission request", params.command, signal);
        if (!allowed) throw new Error(signal?.aborted ? "Operation aborted" : ctx.hasUI
          ? "Permission denied by user" : "Permission required, but no interactive UI is available");
      }
      signal?.throwIfAborted();
      const tool = callMode === "auto"
        ? createBashTool(ctx.cwd, { operations: createSandboxOperations() })
        : createBashTool(ctx.cwd);
      return tool.execute(toolCallId, { command: inspection ?? params.command, timeout: params.timeout }, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...template,
    name: "bash_escalated",
    prepareArguments: undefined,
    label: "bash (outside sandbox)",
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Bash command requiring execution outside the filesystem sandbox" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
      path: Type.String({ minLength: 1, pattern: "\\S", description: "Restricted filesystem path that must be written" }),
      reason: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Necessary write operation and why it requires access to the restricted path" }),
    }, { additionalProperties: false }),
    description: "Request Bash execution outside the entire filesystem sandbox. Use only for necessary writes outside the writable roots or to protected Git metadata. Provide the restricted path and necessary operation. Read-only commands, network access, Python/uv, tests, and shell complexity alone do not justify using this tool; use bash instead. Default/Auto require user approval. YOLO executes without approval. Plan forbids this tool. Approval removes the entire sandbox, not just protection on the declared path.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (mode !== "yolo") {
        const allowed = await approve(ctx, `${MODE_LABELS[mode]} bash escalation request`, `${params.command}\n\nRestricted path: ${params.path}\nReason: ${params.reason}\n\nApproval removes the entire filesystem sandbox for this call.`, signal);
        if (!allowed) throw new Error(signal?.aborted ? "Operation aborted" : ctx.hasUI
          ? "Permission denied by user" : "Permission required, but no interactive UI is available");
      }
      signal?.throwIfAborted();
      return createBashTool(ctx.cwd).execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate);
    },
  });
}
