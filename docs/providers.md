# Provider & Model Compatibility Guide

`opencode-goal-plugin` is designed to work with all LLM providers supported by OpenCode (Anthropic, OpenAI, DeepSeek, Google, OpenCode Zen, Qwen, Ollama, etc.).

However, model compliance and context behavior can vary depending on provider prompt formatting and tool-calling capabilities:

---

## 1. Tool vs Prompt-Based Completion

OpenCode v2 provides canonical tool calling for plugins. This plugin exposes two primary methods of progression:

* **Tool-Driven (`goal_update`):**
  Models supporting structured tool calls call `goal_update` with `status: "working"`, `status: "blocked"`, or `status: "complete"`.
  When declaring completion, the model supplies `summary` and `evidence`.

* **Prompt / Contract Injection:**
  The goal contract (`ACTIVE GOAL (opencode-goal-plugin)`) is injected directly into model calls to ensure durability across context compaction.

---

## 2. Tested Provider Behaviors

| Provider / Model | Status | Verification & Behavioral Notes |
| :--- | :---: | :--- |
| **OpenCode Zen / Free** | :white_check_mark: Verified | Clean tool calling. Autonomously inspects workspace, runs tests, fixes failures, and finishes with verified evidence. |
| **DeepSeek (V3 / Chat)** | :white_check_mark: Verified | High tool-call compliance. Faithfully updates ledger on each iteration; verifies before marking complete. |
| **Anthropic (Claude 3.5 / 3.7 Sonnet)** | :white_check_mark: Verified | Superior reasoning on complex criteria; strictly adheres to negative constraints and boundary restrictions. |
| **OpenAI (GPT-4o / o1 / o3-mini)** | :white_check_mark: Verified | Strong tool fidelity; respects turn limits and reports blockers when dependencies are missing. |
| **Qwen / vLLM / Local Backends** | :white_check_mark: Supported | When using backends with strict chat templates (e.g. single system message), the plugin's contract merges seamlessly without syntax faults. |

---

## 3. Strict-Template Backends

Certain local or self-hosted backends (e.g. vLLM or llama.cpp with specific HuggingFace templates) reject multiple `system` messages or system parts positioned outside the start of the conversation.

The plugin injects its contract into the active session system block rather than creating detached roles, ensuring universal compatibility across strict templates.

---

## 4. Evidence-Gated Completion

A durable goal cannot be considered complete simply because a model states that it feels done.

The plugin enforces an **evidence gate**:
1. To complete a goal, the model must invoke `goal_update` with `status: "complete"`.
2. A descriptive `summary` of what was achieved is required.
3. Concrete `evidence` (such as test output, command exit code, or created artifact) must be recorded in the ledger.
4. If an empty summary is submitted, the engine rejects the transition and instructs the model to provide evidence.
