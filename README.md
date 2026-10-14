# Pi Dev Kit

**English** | [简体中文](README.zh-CN.md)

**A reviewable development workflow for Pi Coding Agent—from understanding a project and clarifying requirements to planning and implementation.**

Pi Dev Kit brings together project navigation, persistent plans, interactive questionnaires, and permission controls. Explore the relevant source, write a Plan, review it, and authorize implementation. Routine commands can run automatically, with approval when additional permissions are needed rather than interruptions at every step.

## Features

| Feature | What it does | Why it helps |
| --- | --- | --- |
| **Source-driven project navigation** | `/init` guides the agent to generate `.ai/map.md` and business flow diagrams from source, configuration parsing, and tests; project-level work is guided to relevant documents and verified against current source | Reusable project context without requiring every document to be loaded into each conversation |
| **Persistent, reviewable plans** | With Plan enabled, the agent can only explore, clarify, and write the selected plan; `/run-plan` records user authorization in that file before starting implementation | Keep goals, scope, approach, and acceptance criteria in the project for review and continuation across sessions |
| **Interactive clarification** | The agent uses `questionnaire` to ask questions, with multiple-choice answers, custom text, revisiting earlier answers, and a final review for multi-question forms | Resolve important ambiguities before implementing assumptions |
| **Less intrusive permissions** | Default permits allowlisted read-only Bash; Auto runs ordinary sandboxed commands and file writes within its permitted boundaries automatically | Routine exploration and development need fewer confirmations; out-of-bounds writes or escalation require approval |
| **Git metadata protection** | Auto Bash mounts the current repository's Git metadata and `.git` entry read-only, including separate and shared worktree metadata | Inspect status and diffs without approval; explicitly request escalation for Bash operations that write Git metadata |
| **Three independent modules** | Enable Workflow, Permissions, and Questionnaire separately; the Plan toggle and permission mode are independent | Choose the capabilities you need without requiring the entire toolkit |

## Installation and quick start

Requires Pi to be installed and Node.js **22.19+**. The currently verified Pi version is **0.84.4**.

```bash
pi install npm:pi-dev-kit
```

Alternatively, install from GitHub. Choose one source, not both:

```bash
pi install git:github.com/Lytherion/pi-dev-kit
```

All three modules are enabled by default. **New sessions start with Plan off and Auto permissions**; existing sessions restore state from the active branch.

The Auto Bash sandbox supports **Linux/WSL only** and requires Git **2.31+**, Bash, bubblewrap, and working user namespaces. On Debian/Ubuntu:

```bash
sudo apt-get install git bash bubblewrap
```

Missing dependencies or unavailable namespaces cause Auto Bash to fail; **it never falls back to unsandboxed execution automatically**. This package does not support Auto Bash sandboxing on macOS or native Windows. You can choose only Workflow/Questionnaire or use local, unsandboxed Default/YOLO execution; runtime behavior on those platforms has not been verified.

After installation, start `pi` in your project directory. Commands such as `/init` and `/plan` below are entered **inside the Pi session**, not in your terminal shell.

## Recommended workflow

```text
Understand → Clarify → Write a Plan → Review and authorize → Implement and verify → Maintain project knowledge
 /init                  /plan on          /run-plan
```

**1. Build project navigation first.** For an existing project, run `/init` at the project root. The agent generates or synchronizes the map and flow diagrams from current source. During this task, only reading, restricted project-document tools, and the bundled questionnaire are available: no business code, configuration, or Plan changes, and no Bash. Review the coverage, important branches, and unverified assumptions afterward; generated documentation is not proof of business correctness.

```text
.ai/
├── map.md                 # Project overview, entry points, and flow navigation
├── flows/                 # Business flow diagrams traceable to source
└── plan/                  # Task plans, authorization, and progress records
```

**2. Clarify requirements, then save if needed.** Run `/plan` or `/plan on` to enter read-only planning immediately, without selecting or creating a file. Describe your task, for example:

```text
Analyze the current login-expiration behavior. Do not implement yet.

Verify the relevant source and callers, and use questionnaire to clarify requirements if needed.
Present the goals, current behavior, proposed rules, affected scope, implementation steps,
and acceptance examples in the conversation first. Do not save a document yet.
```

When you explicitly ask to save the proposal, the agent calls `plan_document`. If no document is bound and Plans exist, choose whether to modify an existing Plan or create a new one. For an existing Plan, select it with the arrow keys; the agent reads and merges its contents before saving. With no files, creation starts directly. The agent offers Chinese/English semantic names plus a custom-name option; enter only the topic, and the tool generates `YYYYMMDD-NN-topic.md` using today's date and the next sequence. Canceling leaves files and the binding unchanged. The first successful save binds the document; subsequent saves update it without selection dialogs.

While Plan is enabled, the agent can use built-in reading tools, allowlisted read-only Bash, the questionnaire, and `plan_document`, which can only write the selected file. It cannot change business code or configuration. Questionnaire answers and saving a proposal **do not authorize implementation**.

**3. Review before starting implementation.** Check that the Plan explains why a change is needed, what will change, which behaviors must remain, and how to verify the result. Once satisfied, run `/run-plan`, which always shows the Plan list, putting the bound document first (otherwise defaulting to the first item). Use the arrow keys and **press Enter to authorize execution immediately**, without a second confirmation. Implementation follows the selected file's current contents: the extension first records authorization, then turns Plan off and starts the task. The permission mode stays unchanged; subsequent controlled writes in Default still require confirmation. Canceling the selection changes neither the file nor the toggle.

Ask the agent to record progress and verification evidence step by step, and to pause for clarification if scope expands, business contracts conflict, or information is insufficient. A new session can continue from the project map and the same authorized Plan rather than relying on previous chat memory.

**4. Verify and maintain project knowledge.** Review tests, diffs, affected shared callers, and actual business results according to the risk of the change. Ask the agent to update affected maps/flows, or run `/init` to synchronize them, then review the output. Avoid regenerating everything for unrelated small changes. Progress, acceptance, and documentation semantics depend on the agent's work and your review—not automatic command guarantees. The toolkit does not automatically commit, push, or roll back Git changes.

**Small tasks do not require a persistent Plan.** Discuss the approach in read-only Plan mode without saving a file, then turn Plan off and explicitly confirm implementation. **For a new project, clarify goals and implement source that can be verified first**, then use `/init`; an empty project cannot yield an evidence-based business flow.

## Commands and permissions

| Command / shortcut | Behavior |
| --- | --- |
| `/init` | Turns Plan off and temporarily restricts tools to maintain `.ai/map.md` and `.ai/flows/*.md`; restores ordinary tools afterward without re-enabling Plan |
| `/plan on` / `/plan off` | Enables planning restrictions / disables them and restores the original tool set; leaves permissions unchanged |
| `/plan` / `Alt+N` | Toggles Plan without file selection or creation. Switching is blocked while busy or during `/init` |
| `/plan select` | Binds an existing or new Plan without changing mode; new documents are created only on first save |
| `/plan clear` | Clears the binding without deleting files or changing mode |
| `/run-plan` | Always lists Plans with the bound one first; Enter records authorization and starts implementation without changing permissions |
| `/permission default\|auto\|yolo` | Selects a permission mode; without arguments, opens the mode menu |
| `Alt+M` | Cycles Default → Auto → YOLO |
| `questionnaire` | An agent tool, not a user slash command; cancellation or non-TUI execution counts as unanswered |

**Plan is a tool restriction, not a separate execution mode.** While enabled, the status shows `Plan · filename` (or just `Plan` without a binding); when disabled, the binding remains visible as `当前计划 · filename`. Existing sessions restore the binding; new sessions clear it. Turning Plan off restores ordinary tools; **binding, switching, and saving do not authorize a task**. The extension does not require every ordinary task to pass through `/run-plan`. YOLO cannot bypass Plan restrictions.

| Permission mode | Controlled file writes / document deletions | Bash |
| --- | --- | --- |
| **Default** | Confirm each operation | Allowlisted read-only commands without escalation run without approval; all others require confirmation. Execution is unsandboxed |
| **Auto** (default) | Ordinary targets inside the project and system temporary directory are allowed automatically; Git-protected paths, existing hard-linked files, and other paths require confirmation | Ordinary commands run automatically in the sandbox; the project and system temporary directory are writable, while other locations and current Git metadata are read-only |
| **YOLO** | This package adds no permission prompts | This package adds no permission prompts or sandbox; Plan and `/init` restrictions still apply |

For Auto Bash writes to Git metadata or paths outside the sandbox's writable roots, the model must explicitly provide `sandbox_permissions="require_escalated"` and a concise `escalation_reason`. **Approval removes the entire sandbox for that Bash call, not just a restriction on one path.** When approval is required, no interactive UI, denial, or cancellation means no execution.

Default and Plan share a conservative read-only Bash allowlist. Typical supported forms:

```bash
pwd
ls -alh src
git status --short --branch
git log --oneline -n 10
git diff --stat
git diff --cached --name-only
```

This is not a classifier for arbitrary read-only commands. It accepts only a single command, simple ASCII arguments, and explicitly supported options. Quotes, non-ASCII arguments, globs, substitutions, redirections, pipes, operators, scripts, multiple lines, and unknown options **require approval in Default and are blocked in Plan**. Use built-in `read/grep/find/ls` for complex paths. See [`extensions/lib/read-only.ts`](extensions/lib/read-only.ts) for the complete rules.

Git inspection permitted without approval in Default, or allowed in Plan, disables paging, optional index writes, and fsmonitor; `log/diff` additionally disable external diff and textconv. Outside Plan, Auto/YOLO commands are not rewritten by this allowlist.

## Choose modules and migrate from the old package

Run `pi config` and select the extensions you need:

| Module | Entry point | Responsibilities |
| --- | --- | --- |
| Workflow | `extensions/workflow.ts` | Plan, project navigation, document tools, and task entry points |
| Permissions | `extensions/permissions.ts` | Three permission modes, controlled write approvals, and the Bash sandbox |
| Questionnaire | `extensions/questionnaire.ts` | Interactive multi-question forms |

Each module can run independently. Without Permissions, Workflow's restricted document writes do not request this package's permission approval, but path and tool restrictions remain enforced. Plan accepts only built-in Bash or Bash from the bundled Permissions module, and the bundled Questionnaire; unverified third-party tools with the same names are not trusted.

This project continues development from `pi-simple-permissions`. Installing the new package does not remove the old one. Use `pi list` to check the configured source and avoid loading both. For an old npm installation:

```bash
pi remove npm:pi-simple-permissions
pi install npm:pi-dev-kit
```

For Git or local installations, remove the actual source shown in the list; use `--local` for project-level installations. After migration, review module settings and the permission mode, then enable Plan as needed.

## Boundaries and release validation

- **Git protection does not prohibit every Git command.** Auto protects the current repository's metadata as discovered at the start of the call. Operations that only modify working-tree files, other repositories in temporary directories, and repositories created during the command are not covered by the same protection.
- **A failed check is not approval.** Auto file targets are judged by their real symlink destinations; resolvable targets outside the permitted boundary require confirmation. Dangling links, damaged Git metadata, or failure to discover protected paths cause the current call that relies on that check to fail—without automatic approval prompts, fallback, or automatic termination of the entire agent session. Symlinked `.git` entries are unsupported in Auto; Bash requires explicit escalation.
- **This is not an adversarial security sandbox.** The allowlist assumes a trusted host Bash, PATH, and standard programs; it does not defend against malicious startup scripts, shell functions, or replaced executables. The sandbox does not isolate reads, and network access remains open. Bash hard links, concurrent path replacement, local services, and other extensions/tools do not have complete adversarial protection. Terminal commands run directly by the user are outside this package's tool restrictions. Load only trusted extensions and review the full command before approving escalation.

Pi loads the TypeScript extensions directly; no JavaScript build output is required. The npm package contains only the installable files: `extensions/`, English and Chinese READMEs, LICENSE, and `package.json`. The Git repository also includes `.gitignore` to keep local development files out of commits. Internal documents, tests, development configuration, and the lockfile are kept in the maintainer's local workspace, not published.

Release checks run locally before `npm publish`: strict types and unused code, Plan/permission/questionnaire behavior, real bwrap and Git/worktree protection, and loading the actual npm package through Pi. There is no GitHub CI; the public checkout alone does not include the files needed to run those development checks.

Licensed under MIT.
