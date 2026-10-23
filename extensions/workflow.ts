import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, renameSync, linkSync, unlinkSync, fchmodSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { Type } from "typebox";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readOnlyBash } from "./lib/read-only.ts";

const safeTools = new Set(["read", "grep", "find", "ls", "bash", "plan_document", "questionnaire"]);
const workflowTools = new Set(["plan_document", "project_document"]);
const topicPattern = /^[\p{Script=Han}a-zA-Z0-9][\p{Script=Han}a-zA-Z0-9 _-]*$/u;
const datePattern = /^\d{8}-\d{2,}-([\p{Script=Han}a-zA-Z0-9][\p{Script=Han}a-zA-Z0-9 _-]*)\.md$/u;

function isPlanName(name: string): boolean {
  return datePattern.test(name);
}

function fileInfo(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function planPath(cwd: string, name: string): string {
  if (!isPlanName(name)) throw new Error("Plan 文件名须为 YYYYMMDD-NN-语义名.md");
  const project = realpathSync(cwd);
  const root = resolve(project, ".ai", "plan");
  const ai = resolve(project, ".ai");
  for (const path of [ai, root]) {
    const stat = fileInfo(path);
    if (stat && !stat.isDirectory()) {
      throw new Error("Plan 目录不能是符号链接或普通文件");
    }
  }
  const target = join(root, name);
  const stat = fileInfo(target);
  if (stat && (!stat.isFile() || stat.nlink !== 1)) {
    throw new Error("Plan 文件不能是链接或目录");
  }
  return target;
}

function atomicWrite(target: string, content: string, validate: () => void, createOnly = false): void {
  validate();
  mkdirSync(dirname(target), { recursive: true });
  validate();
  const temp = join(dirname(target), `.document-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let open = true;
  try {
    const previous = fileInfo(target);
    if (previous) fchmodSync(fd, previous.mode);
    writeFileSync(fd, content);
    closeSync(fd);
    open = false;
    validate();
    if (createOnly) {
      linkSync(temp, target);
      unlinkSync(temp);
    } else {
      renameSync(temp, target);
    }
  } catch (error) {
    if (open) closeSync(fd);
    try { unlinkSync(temp); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export async function savePlan(cwd: string, name: string, content: string, expected?: string, signal?: AbortSignal, createOnly = false): Promise<void> {
  const target = planPath(cwd, name);
  await withFileMutationQueue(target, async () => {
    signal?.throwIfAborted();
    atomicWrite(target, content, () => {
      planPath(cwd, name);
      if (createOnly && fileInfo(target)) throw new Error("该 Plan 已存在，请重新选择或新建");
      if (expected !== undefined && readFileSync(target, "utf8") !== expected) {
        throw new Error("Plan 已被其他进程修改，请重新选择后再执行");
      }
    }, createOnly);
  });
}

function projectDocumentPath(cwd: string, input: string): string {
  const project = realpathSync(cwd);
  const target = resolve(project, input);
  const map = resolve(project, ".ai/map.md");
  const flows = resolve(project, ".ai/flows");
  const rel = relative(flows, target);
  if (target !== map && !(rel && !/[\\/]/.test(rel) && !rel.startsWith("..") && !isAbsolute(rel) && target.endsWith(".md"))) {
    throw new Error("项目文档仅限 .ai/map.md 或 .ai/flows/ 直属 Markdown 文件");
  }
  for (const path of [resolve(project, ".ai"), ...(target === map ? [] : [flows])]) {
    const stat = fileInfo(path);
    if (stat && !stat.isDirectory()) throw new Error("项目文档目录不能是链接或普通文件");
  }
  const stat = fileInfo(target);
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("项目文档不能是链接、目录或硬链接");
  return target;
}

function planNames(cwd: string): string[] {
  const root = resolve(cwd, ".ai", "plan");
  if (!existsSync(root)) return [];
  planPath(cwd, "20000101-01-check.md");
  return readdirSync(root).filter((name) => isPlanName(name) && lstatSync(join(root, name)).isFile()).sort();
}

function planInfo(cwd: string, name: string): string {
  const text = readFileSync(planPath(cwd, name), "utf8");
  const title = text.match(/^# (.+)$/m)?.[1] ?? name;
  const status = text.match(/^status:\s*(.+)$/m)?.[1] ?? "未标记";
  const done = (text.match(/^- \[x\]/gim) ?? []).length;
  const total = (text.match(/^- \[[ x]\]/gim) ?? []).length;
  return `${name} | ${title} | ${status} | ${done}/${total}`;
}

export function registerWorkflow(pi: ExtensionAPI, allowDocumentWrite: (ctx: ExtensionContext, path: string, action: "write" | "delete", signal?: AbortSignal) => Promise<boolean>): void {
  let planEnabled = false;
  let currentPlan: string | undefined;
  let pendingPlan = false;
  let toolsBeforePlan: string[] | undefined;
  let initActive = false;
  let toolsBeforeInit: string[] | undefined;
  let navigationHintSent = false;

  function planToolAvailable(): boolean {
    return available(["plan_document"]).length === 1;
  }

  function available(names: string[]): string[] {
    const tools = pi.getAllTools();
    const commands = pi.getCommands();
    const owner = commands.find((command) => command.name === "plan" && command.source === "extension")?.sourceInfo;
    const controller = commands.find((command) => command.name === "permission" && command.source === "extension")?.sourceInfo;
    return names.filter((name) => tools.some((tool) => {
      if (tool.name !== name) return false;
      if (name === "bash" && tool.sourceInfo.source === "builtin") return true;
      if (name === "questionnaire" || name === "bash") {
        if (!owner || tool.sourceInfo.source !== owner.source) return false;
        if (name === "bash" && (!controller || tool.sourceInfo.path !== controller.path || tool.sourceInfo.source !== controller.source)) return false;
        if (owner.baseDir || tool.sourceInfo.baseDir) return Boolean(owner.baseDir && tool.sourceInfo.baseDir === owner.baseDir);
        return dirname(tool.sourceInfo.path) === dirname(owner.path);
      }
      return workflowTools.has(name)
        ? Boolean(owner && tool.sourceInfo.path === owner.path && tool.sourceInfo.source === owner.source)
        : tool.sourceInfo.source === "builtin";
    }));
  }

  function status(ctx: ExtensionContext): void {
    const label = planEnabled ? "Plan" : "当前计划";
    const text = currentPlan ? `${label} · ${currentPlan}` : planEnabled ? label : undefined;
    ctx.ui.setStatus("dev-kit-plan", text ? ctx.ui.theme.fg(planEnabled ? "warning" : "muted", text) : undefined);
  }

  function rememberPlan(ctx: ExtensionContext): void {
    pi.appendEntry("dev-kit-plan", { enabled: planEnabled, plan: currentPlan, pending: pendingPlan, tools: toolsBeforePlan ?? pi.getActiveTools() });
    status(ctx);
  }

  function bindPlan(ctx: ExtensionContext, name: string | undefined, pending = false): void {
    if (name) planPath(ctx.cwd, name);
    currentPlan = name;
    pendingPlan = pending;
    rememberPlan(ctx);
  }

  function setPlan(enabled: boolean, ctx: ExtensionContext, name = currentPlan): void {
    if (enabled) {
      if (name) planPath(ctx.cwd, name);
      if (!planToolAvailable()) throw new Error("当前 Plan 写入工具被其他扩展覆盖或不可用");
      if (!planEnabled) toolsBeforePlan = pi.getActiveTools().filter((tool) => !workflowTools.has(tool));
      pi.setActiveTools(available([...safeTools]));
    } else {
      pi.setActiveTools(toolsBeforePlan ?? pi.getActiveTools().filter((tool) => !workflowTools.has(tool)));
      toolsBeforePlan = undefined;
    }
    planEnabled = enabled;
    if (currentPlan !== name) pendingPlan = false;
    currentPlan = name;
    rememberPlan(ctx);
  }

  pi.registerTool({
    name: "plan_document",
    label: "Current Plan",
    description: "Only in Plan Mode and when the user explicitly requests saving: create or replace the bound Plan. When none is bound, offer existing/new selection and provide 2-5 topic-specific Chinese/English name suggestions (semantic names only, no date, sequence or extension). Selecting an existing Plan first binds it without overwriting: read it, merge the proposal, then call again. Subsequent saves update the bound file without dialogs. No other file is writable.",
    parameters: Type.Object({
      content: Type.String({ description: "Complete Markdown for the bound Plan; read existing contents before updating" }),
      names: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 5, description: "Chinese/English semantic name suggestions for a new Plan" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!planEnabled) throw new Error("未处于 Plan Mode");
      signal?.throwIfAborted();
      const selected = currentPlan ? { name: currentPlan, pending: pendingPlan } : await choosePlan(ctx, params.names, params.content, signal);
      if (!selected) throw new Error("未选择 Plan，未保存文档；仍处于规划模式");
      const { name, pending } = selected;
      signal?.throwIfAborted();
      if (!currentPlan && !pending) {
        bindPlan(ctx, name);
        return { content: [{ type: "text", text: `已选择 .ai/plan/${name}，尚未保存。请先读取该文件，将方案合并到现有内容后再次调用 plan_document。` }], details: undefined };
      }
      const target = planPath(ctx.cwd, name);
      signal?.throwIfAborted();
      if (!await allowDocumentWrite(ctx, target, "write", signal)) throw new Error("用户未允许写入当前 Plan");
      await savePlan(ctx.cwd, name, params.content, undefined, signal, pending);
      bindPlan(ctx, name);
      return { content: [{ type: "text", text: `已更新 .ai/plan/${name}` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "project_document",
    label: "Project Documentation",
    description: "Only during /init: atomically write or safely delete .ai/map.md and direct .ai/flows/*.md files.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("write"), Type.Literal("delete")]),
      path: Type.String({ description: "Relative path: .ai/map.md or .ai/flows/<name>.md" }),
      content: Type.Optional(Type.String({ description: "Complete Markdown; required for write" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!initActive) throw new Error("project_document 仅可在 /init 期间使用");
      const target = projectDocumentPath(ctx.cwd, params.path);
      if (params.action === "write" && params.content === undefined) throw new Error("write 操作必须提供完整 content");
      signal?.throwIfAborted();
      if (!await allowDocumentWrite(ctx, target, params.action, signal)) throw new Error("用户未允许修改项目文档");
      await withFileMutationQueue(target, async () => {
        signal?.throwIfAborted();
        if (params.action === "delete") {
          projectDocumentPath(ctx.cwd, params.path);
          if (fileInfo(target)) unlinkSync(target);
        } else {
          atomicWrite(target, params.content!, () => { projectDocumentPath(ctx.cwd, params.path); });
        }
      });
      const verb = params.action === "delete" ? "已删除" : "已更新";
      return { content: [{ type: "text", text: `${verb} ${relative(realpathSync(ctx.cwd), target)}` }], details: undefined };
    },
  });

  async function selectExisting(ctx: ExtensionContext, names: string[], title: string, signal?: AbortSignal): Promise<string | undefined> {
    const ordered = currentPlan && names.includes(currentPlan)
      ? [currentPlan, ...names.filter((name) => name !== currentPlan)] : names;
    const options = ordered.map((name) => planInfo(ctx.cwd, name));
    const choice = await ctx.ui.select(title, options, { signal });
    const index = choice === undefined ? -1 : options.indexOf(choice);
    return index < 0 ? undefined : ordered[index];
  }

  async function choosePlan(ctx: ExtensionContext, suggestions?: string[], content = "", signal?: AbortSignal): Promise<{ name: string; pending: boolean } | undefined> {
    if (!ctx.hasUI) { ctx.ui.notify("此操作需要交互式界面", "warning"); return; }
    const names = planNames(ctx.cwd);
    if (names.length) {
      const action = await ctx.ui.select("纳入 Plan", ["修改已有 Plan", "新建 Plan"], { signal });
      if (!action) return;
      if (action === "修改已有 Plan") {
        const name = await selectExisting(ctx, names, "选择当前 Plan", signal);
        return name ? { name, pending: false } : undefined;
      }
      if (action !== "新建 Plan") return;
    }
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.replace(/[^\p{Script=Han}a-zA-Z0-9 _-]+/gu, "-").replace(/^[ _-]+|[ _-]+$/g, "").slice(0, 80);
    const topics = [...new Set(suggestions ?? [title || "实施方案", "功能优化", "问题修复"])];
    if (topics.some((topic) => !topicPattern.test(topic) || topic.length > 80)) {
      throw new Error("Plan 语义名须为中文、英文、数字、空格、下划线或连字符，长度不超过 80 个字符");
    }
    const choice = await ctx.ui.select("选择新 Plan 名称", [...topics, "自定义名称"], { signal });
    if (!choice) return;
    const topic = choice === "自定义名称"
      ? (await ctx.ui.input("Plan 语义名（中文/英文，无需日期、序号或 .md）", undefined, { signal }))?.trim()
      : topics.includes(choice) ? choice : undefined;
    if (!topic) return;
    if (!topicPattern.test(topic) || topic.length > 80) {
      ctx.ui.notify("名称须为中文、英文、数字、空格、下划线或连字符，长度不超过 80 个字符", "warning");
      return;
    }
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const seq = Math.max(0, ...names.filter((name) => name.startsWith(`${date}-`)).map((name) => Number(name.split("-")[1]))) + 1;
    const name = `${date}-${String(seq).padStart(2, "0")}-${topic}.md`;
    planPath(ctx.cwd, name);
    return { name, pending: true };
  }

  async function configurePlan(enabled: boolean, ctx: ExtensionContext): Promise<void> {
    if (initActive || !ctx.isIdle()) { ctx.ui.notify("请等待当前任务结束后再切换 Plan", "warning"); return; }
    setPlan(enabled, ctx);
  }

  pi.registerCommand("plan", {
    description: "Plan restrictions and binding: /plan [on|off|select|clear]",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "select" || value === "clear") {
        if (initActive || !ctx.isIdle()) { ctx.ui.notify("请等待当前任务结束后再切换 Plan", "warning"); return; }
        if (value === "clear") bindPlan(ctx, undefined);
        else {
          const selected = await choosePlan(ctx);
          if (selected) bindPlan(ctx, selected.name, selected.pending);
        }
        return;
      }
      if (value && value !== "on" && value !== "off") { ctx.ui.notify("用法：/plan [on|off|select|clear]", "warning"); return; }
      await configurePlan(value ? value === "on" : !planEnabled, ctx);
    },
  });

  pi.registerShortcut("alt+n", {
    description: "Toggle Plan restrictions",
    handler: async (ctx) => { await configurePlan(!planEnabled, ctx); },
  });

  pi.registerCommand("run-plan", {
    description: "Choose a Plan and authorize its execution",
    handler: async (_args, ctx) => {
      if (initActive || !ctx.isIdle()) { ctx.ui.notify("请等待当前任务结束", "warning"); return; }
      if (!ctx.hasUI) { ctx.ui.notify("此操作需要交互式界面", "warning"); return; }
      const names = planNames(ctx.cwd);
      if (!names.length) { ctx.ui.notify("当前项目没有 Plan", "warning"); return; }
      const name = await selectExisting(ctx, names, "选择即授权执行该 Plan");
      if (!name) return;
      const target = planPath(ctx.cwd, name);
      const text = readFileSync(target, "utf8");
      const record = `\n- ${new Date().toISOString()}：用户通过 /run-plan 选择本 Plan，授权按当前内容执行。\n`;
      const updated = /^status:\s*.+$/m.test(text)
        ? text.replace(/^status:\s*.+$/m, "status: IN_PROGRESS")
        : text;
      // Persist authorization before starting; later sessions resume from this document.
      const heading = updated.includes("\n## 执行授权记录\n") ? "" : "\n## 执行授权记录\n";
      await savePlan(ctx.cwd, name, `${updated.trimEnd()}\n${heading}${record}`, text);
      pendingPlan = false;
      setPlan(false, ctx, name);
      pi.sendUserMessage(`用户刚通过 /run-plan 授权执行 .ai/plan/${name}。先读该文件、相关 map/flow 与当前源码，核验工作区现状；在所选 Plan 范围内实施，逐项记录进度与证据。发现契约冲突或范围扩大即暂停询问。`);
    },
  });

  pi.registerCommand("init", {
    description: "Generate or synchronize .ai/map.md and business flow diagrams from current code",
    handler: async (_args, ctx) => {
      if (initActive) { ctx.ui.notify("/init 正在执行", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("请等待当前任务结束后再运行 /init", "warning"); return; }
      setPlan(false, ctx);
      if (!available(["project_document"]).length) {
        ctx.ui.notify("项目文档工具被其他扩展覆盖或不可用", "warning");
        return;
      }
      toolsBeforeInit = pi.getActiveTools().filter((name) => name !== "plan_document" && name !== "project_document");
      initActive = true;
      pi.setActiveTools(available(["read", "grep", "find", "ls", "project_document", "questionnaire"]));
      pi.sendUserMessage("用户通过 /init 授权同步当前项目的 .ai/map.md 和 .ai/flows/。先读源码、配置解析代码和测试；不得读取 README、旧 map/flow 或用户手册来推断业务事实，已有 map/flow 仅可在源码分析完成后用于保留仍有效的节点 ID、链接及用户内容。map 保持短小并用相对链接导航。首次须生成 map 及至少一份有真实处理分支的 Mermaid 业务 flow。flow 按业务阶段编号，文件名和标题包含实际节点范围，例如 01-order-validation-A01-A12.md；小项目可只有一份。Mermaid 使用稳定的 A01、A02 等节点 ID，以自然语言完整表达处理、判断条件和去向；源码与测试映射放在图外，并标注已核验和未核验范围。已有文件要更新过时内容，并用 project_document 删除被替代或失效的文档，不留废弃占位文件。不得修改业务源码、配置或 Plan 契约。报告覆盖范围、改动文件和无法静态核验的部分；若不能从源码还原可靠流程，明确报告未完成，不编造。", { deliverAs: "followUp" });
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "questionnaire" && !available(["questionnaire"]).length) {
      return { block: true, reason: "问答工具来源未经核验" };
    }
    if ((initActive || planEnabled) && !available([event.toolName]).length) {
      return { block: true, reason: "当前限制只允许来源已核验的工具" };
    }
    if (initActive) {
      if (["read", "grep", "find", "ls", "project_document", "questionnaire"].includes(event.toolName)) return;
      return { block: true, reason: "/init 仅可读项目并通过 project_document 维护 map/flow" };
    }
    if (event.toolName === "plan_document" && !planEnabled) {
      return { block: true, reason: "当前不是 Plan Mode" };
    }
    if (planEnabled && !safeTools.has(event.toolName)) {
      return { block: true, reason: "Plan Mode 只允许只读工具和当前 Plan 文档写入工具" };
    }
    if (planEnabled && event.toolName === "bash") {
      const inspection = readOnlyBash(event.input.command);
      if (!inspection) {
        return { block: true, reason: "Plan 只允许白名单中的简单只读 Bash（pwd、基本 ls、受限 git status/log/diff）；未知参数、复杂 Shell 和提权请求均被拒绝" };
      }
      event.input.command = inspection;
    }
  });

  pi.on("agent_settled", () => {
    if (!initActive) return;
    initActive = false;
    pi.setActiveTools(toolsBeforeInit ?? pi.getActiveTools());
    toolsBeforeInit = undefined;
  });

  pi.on("before_agent_start", (event) => {
    const guide = navigationHintSent ? "" : "\n\n## Project navigation\nFor project-level tasks in a new session, first read .ai/map.md when it exists; then read only relevant flows and verify current source and tests. For narrow questions with explicit paths, navigate directly. Do not inject the whole map every turn.";
    navigationHintSent = true;
    const plan = planEnabled ? `\n\n## Plan Mode\nExplore without side effects. Bash permits only simple read-only whitelist forms: pwd, ls -alh, git status --short, git log --oneline -n 10, git diff --stat, and their supported options. No quoting, expansion, redirection, compound commands, scripts, unknown options or escalation. Use native read/grep/find/ls for other inspection. Git inspection disables optional locks, fsmonitor, external diff and textconv. Discuss requirements and present proposals in the conversation first. Do not ask the user to select or create a Plan just to discuss a task. Only call plan_document when the user explicitly requests saving a proposal. ${currentPlan ? `Only the current Plan .ai/plan/${currentPlan} may be updated through plan_document. Read its contents before updating when the file exists; do not ask the user to select again.` : "No Plan is selected and no file needs to be created. On the first save, plan_document will offer existing/new selection. Supply 2-5 topic-specific Chinese/English semantic names in names; dates, sequences and extensions are generated automatically."} No business source, configuration or flow changes. Saving a Plan is not execution authorization.` : "";
    const binding = !planEnabled && currentPlan ? `\n\n## Current Plan\nBound document: .ai/plan/${currentPlan}. Binding does not authorize execution or writing. Do not automatically apply unrelated tasks to it.` : "";
    return { systemPrompt: event.systemPrompt + guide + plan + binding };
  });

  pi.on("session_start", (event, ctx) => {
    const entry = ctx.sessionManager.getBranch().filter((item) => item.type === "custom" && item.customType === "dev-kit-plan").pop() as { data?: { enabled?: boolean; plan?: string; pending?: boolean; tools?: string[] } } | undefined;
    const previousTools = toolsBeforeInit ?? toolsBeforePlan;
    initActive = false;
    toolsBeforeInit = undefined;
    navigationHintSent = false;
    planEnabled = event.reason !== "new" && entry?.data?.enabled === true;
    currentPlan = event.reason === "new" ? undefined : entry?.data?.plan;
    pendingPlan = event.reason !== "new" && entry?.data?.pending === true;
    const savedTools = entry?.data?.tools;
    const baseline = event.reason !== "new" && Array.isArray(savedTools) ? savedTools.filter((name) => typeof name === "string" && !workflowTools.has(name) && pi.getAllTools().some((tool) => tool.name === name)) : undefined;
    toolsBeforePlan = baseline ?? previousTools ?? pi.getActiveTools().filter((name) => !workflowTools.has(name));
    if (planEnabled && planToolAvailable()) {
      pi.setActiveTools(available([...safeTools]));
    } else {
      planEnabled = false;
      pi.setActiveTools(toolsBeforePlan);
      toolsBeforePlan = undefined;
    }
    status(ctx);
  });
}

export default function workflow(pi: ExtensionAPI): void {
  registerWorkflow(pi, async (ctx, path, action, signal) => {
    let decision: Promise<boolean> | undefined;
    pi.events.emit("pi-dev-kit:approve-document-write", {
      ctx, path, action, signal,
      respond(value: Promise<boolean>) { decision ??= value; },
    });
    return decision ? await decision : true;
  });
}
