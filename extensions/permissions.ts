import { StringEnum } from "@earendil-works/pi-ai";
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
  sandbox_permissions?: "require_escalated";
  escalation_reason?: string;
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
      boundaryText = `\n\n## Permission boundary\n\nThe active permission mode is ${MODE_LABELS[mode]}. Network access and network-search tools are allowed in every mode.\n\nAuto: Bash commands run automatically inside a Linux/WSL filesystem sandbox. Omit sandbox_permissions and escalation_reason for normal calls. The current working directory and system temporary directory are writable; the current repository's Git metadata and .git entry are read-only. Read-only commands, network access, Python/uv, quoting, pipes, redirection, and scripts do not by themselves require escalation. Request sandbox_permissions="require_escalated" only when a necessary operation is known to require writing outside those writable roots or to protected Git metadata, or when a sandbox failure identifies that requirement. The escalation_reason must identify the restricted filesystem path and necessary operation, not merely describe the task. Approval runs this call outside the sandbox. This does not police every Git command or other repositories, and is not an adversarial security sandbox.\n\nDefault: Controlled writes and Bash commands outside the shared read-only whitelist require approval. Only accepted simple pwd, basic ls, and supported git status/log/diff forms run without approval; quoting, operators, substitutions, redirection, scripts, and unknown options require approval in Default.\n\nPlan restrictions apply independently in every permission mode. In Default and Plan, recognized Git inspection disables optional locks, fsmonitor, external diff and textconv.`;
    }
    return { systemPrompt: `${event.systemPrompt}${boundaryText}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    const callMode = mode;
    if (callMode === "yolo") return;
    if (event.toolName === "bash") {
      const owner = pi.getCommands().find((command) => command.name === "permission" && command.source === "extension")?.sourceInfo;
      const bash = pi.getAllTools().find((tool) => tool.name === "bash");
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
    sandbox_permissions: Type.Optional(StringEnum(["require_escalated"] as const, {
      description: "Omit for normal calls. Set require_escalated only when a necessary operation requires writing outside the Auto sandbox's writable roots or to protected Git metadata. Read-only commands, network access, and command complexity alone do not justify escalation. Requires user approval in Default/Auto.",
    })),
    escalation_reason: Type.Optional(Type.String({
      maxLength: 100,
      description: "Omit unless requesting escalation. Identify the restricted filesystem path and necessary operation; do not merely describe the task's purpose.",
    })),
  });

  pi.registerTool({
    ...template,
    name: "bash",
    label: "bash (permissioned)",
    executionMode: "sequential",
    parameters: bashParameters,
    description: `${template.description}\n\nAuto: Normal Bash calls run automatically inside a Linux/WSL filesystem sandbox. Omit sandbox_permissions and escalation_reason for normal calls. Only the current working directory and system temporary directory are writable; the current repository's Git metadata and .git entry are read-only. Read-only commands, network access, Python/uv, and shell syntax are not escalation reasons by themselves. Request sandbox_permissions="require_escalated" only when a necessary operation is known to require writing outside those writable roots or to protected Git metadata, or when a sandbox failure identifies that requirement. The escalation_reason must identify the restricted filesystem path and necessary operation, not merely describe the task. Approval runs this call outside the sandbox.\n\nDefault: Only simple pwd, basic ls, and supported git status/log/diff forms accepted by the shared read-only whitelist run without approval; other commands require approval. Recognized Git inspection disables optional locks, fsmonitor, external diff and textconv. Network access is unrestricted. Plan restrictions apply independently in every permission mode.`,
    async execute(toolCallId, params: BashParams, signal, onUpdate, ctx) {
      const callMode = mode;
      const command = params.command.trim();
      const escalated = params.sandbox_permissions === "require_escalated";
      const inspection = callMode === "default" && !escalated ? readOnlyBash(params.command) : undefined;
      const needsApproval = callMode !== "yolo" && ((callMode === "default" && !inspection) || escalated);

      if (needsApproval) {
        const reasons = [
          callMode === "default" ? "Default mode" : undefined,
          escalated ? `filesystem escalation${params.escalation_reason ? `: ${params.escalation_reason}` : ""}` : undefined,
        ].filter(Boolean).join("; ");
        const allowed = await approve(
          ctx,
          `${MODE_LABELS[callMode]} bash permission request`,
          `${command}\n\nReason: ${reasons}`,
          signal,
        );
        if (!allowed) {
          throw new Error(signal?.aborted
            ? "Operation aborted"
            : ctx.hasUI
              ? "Permission denied by user"
              : "Permission required, but no interactive UI is available");
        }
      }

      signal?.throwIfAborted();
      const useSandbox = callMode === "auto" && !escalated;
      const tool = useSandbox
        ? createBashTool(ctx.cwd, { operations: createSandboxOperations() })
        : createBashTool(ctx.cwd);
      return tool.execute(
        toolCallId,
        { command: inspection ?? command, timeout: params.timeout },
        signal,
        onUpdate,
      );
    },
  });
}
