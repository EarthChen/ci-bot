# Shared Runtime with Static Vertical Agents

The project will extract a shared Pi Agent Runtime for session creation, model/authentication policy, worker lifecycle, budgets, and trusted resource loading. Business-specific Agents will be statically registered, type-checked Vertical Agent definitions that supply prompt resources, append-only system instructions, skills, named model/capability policies, and business-to-prompt mapping. This avoids duplicating the runtime while deliberately rejecting a generic workflow engine, dynamic agent discovery, dynamic tool plugins, mandatory structured output, and mandatory external validation before a second concrete use case proves those abstractions necessary.

## Consequences

The CI self-heal workflow remains responsible for CI logs, worktrees, G3/test/MR gates, and its domain result parsing. Ordinary coding Agents may rely solely on skill-directed self-validation and human review; the shared runtime records execution facts but does not decide business success.
