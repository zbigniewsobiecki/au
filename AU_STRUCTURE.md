# AU File Structure Reference

This document describes the .au file format, a YAML-based documentation format for AI agents to understand codebases.

## Overview

AU (Agent Understanding) files capture structured knowledge about source files, directories, and repositories. They enable AI agents to:

- Understand code purpose and architecture without reading every file
- Navigate relationships and dependencies
- Trace data flows through the system
- Know which areas are critical or uncertain

## File Naming Conventions

AU files follow a predictable naming pattern:

| Source Type | AU File Path | Example |
|-------------|--------------|---------|
| Repository root | `.au` | `.au` |
| Directory | `<dir>/.au` | `src/lib/.au` |
| File | `<file>.au` | `src/index.ts.au` |

Detection rules:
- Path `.` or empty → repository
- Path ending with extension (not starting with `.`) → file
- Path without extension → directory
- Known dotfile directories (`.git`, `.github`, `.vscode`, etc.) → directory
- Other dotfiles (`.gitignore`, `.env`, etc.) → file

## YAML Serialization

AU files use YAML with these formatting options:

```yaml
indent: 2
lineWidth: 100
defaultKeyType: PLAIN
defaultStringType: QUOTE_DOUBLE
```

Multi-line strings use YAML block scalars:

```yaml
summary: |
  This is a multi-line summary.
  It preserves line breaks.
```

## Document Types

Every AU document has a `type` in its meta section:

| Type | Description |
|------|-------------|
| `repository` | Root-level documentation for the entire codebase |
| `directory` | Documentation for a folder and its contents |
| `file` | Documentation for a single source file |

## Top-Level Sections

The table below shows all sections and which document types support them:

| Section | Repository | Directory | File | Description |
|---------|:----------:|:---------:|:----:|-------------|
| `meta` | ✓ | ✓ | ✓ | Auto-managed metadata |
| `layer` | - | ✓ | ✓ | Architectural layer |
| `behaviors` | - | - | ✓ | Side effects and concurrency |
| `understanding` | ✓ | ✓ | ✓ | Core documentation |
| `contents` | - | ✓ | - | Directory contents listing |
| `topics` | ✓ | ✓ | ✓ | Searchable topic tags |
| `questions_answered` | - | - | ✓ | Questions this file answers |
| `relationships` | - | ✓ | ✓ | Dependencies and connections |
| `parent` | - | ✓ | ✓ | Parent directory reference |
| `uncertainty` | ✓ | ✓ | ✓ | Areas of uncertainty |
| `entry_points` | ✓ | - | - | System entry points |
| `flows` | ✓ | - | - | Business flow definitions |
| `data_contracts` | ✓ | - | - | Shared data shapes |

---

## Section Reference

### meta

**Auto-managed. Do not edit directly.**

```yaml
meta:
  au: "1.0"                                    # Schema version
  id: "au:path/to/thing"                       # Unique identifier
  type: "repository | directory | file"        # Document type
  analyzed_at: "2025-01-08T15:00:00Z"          # Analysis timestamp
  analyzed_hash: "b9e939da632151d384a4bc8737af9611"  # MD5 of source
```

The `id` uses `au:` prefix:
- Repository: `au:`
- Directory: `au:src/lib`
- File: `au:src/index.ts`

The `analyzed_hash` is an MD5 hash of the source file content, used to detect when documentation is stale.

---

### layer

**Required for:** directory, file

Indicates the architectural layer:

```yaml
layer: "frontend | api | service | repository | database | infrastructure | config | shared"
```

---

### behaviors

**Applies to:** file (service/repository/database layers only)

Documents side effects and concurrency handling:

```yaml
behaviors:
  has_side_effects: false    # Calls email, payments, webhooks, message queues
  is_transactional: false    # Uses BEGIN/COMMIT, $transaction, etc.
  concurrency_strategy: "none"  # "none" | "optimistic" | "pessimistic"
```

Concurrency strategies:
- `none` - No special handling
- `optimistic` - Version checks, retry on conflict
- `pessimistic` - Row locks, explicit locking

---

### understanding

**Required for:** all types (structure varies)

The core documentation section with different fields by type.

#### Repository fields

```yaml
understanding:
  name: "Project Name"

  summary: |
    What this project does in 1-3 sentences.

  purpose: |
    Why this project exists. What problem does it solve?

  architecture:
    style: "Monolith | Microservices | Monorepo | Serverless | Mobile | Desktop | Embedded | Other"
    layers:
      - name: "Layer Name"
        path: "path/to/layer/"
        description: "What this layer does"

  stack:
    language: "TypeScript 5.x"
    runtime: "Node 20"
    framework: "Next.js 14"
    database: "PostgreSQL"

  conventions:
    file_naming: "kebab-case"

  critical_areas:
    - path: "src/auth/"
      reason: "Security-critical authentication logic"
```

#### Directory fields

```yaml
understanding:
  summary: |
    What this directory contains.

  responsibility: |
    What this directory owns. What concerns belong here.

  design_principles:
    - "Principle or pattern description"

  conventions:
    file_naming: "kebab-case"
```

#### File fields

```yaml
understanding:
  summary: |
    What this file does in 1-3 sentences.

  purpose: |
    Why this file exists. What problem does it solve?

  exports:
    - name: "ExportedThing"
      kind: "function | class | const | type | interface"
      signature: "(args) => ReturnType"
      description: "What it does"

  key_logic: |
    Description of main algorithm or business rules.

  edge_cases:
    - scenario: "Edge case description"
      behavior: "How it's handled"

  constraints:
    - "Business rule this code enforces (e.g., 'User must be active')"
```

---

### contents

**Applies to:** directory only

Lists directory contents with summaries:

```yaml
contents:
  - name: "subdirectory/"
    summary: "What it contains"
  - name: "file.ts"
    summary: "What it does"
```

The validator checks that declared contents match actual directory contents.

---

### topics

**Applies to:** all types

Searchable tags for discovery:

```yaml
topics:
  - "authentication"
  - "user-management"
  - "security"
```

---

### questions_answered

**Applies to:** file only

Questions this file can answer:

```yaml
questions_answered:
  - "How do I authenticate a user?"
  - "What handles JWT validation?"
  - "Where is the login endpoint?"
```

---

### relationships

**Applies to:** directory, file

Documents connections to other parts of the codebase.

#### depends_on

Standard dependencies:

```yaml
relationships:
  depends_on:
    - ref: "au:path/to/dependency"
      symbols: ["ImportedThing"]           # File only
      kind: "type_import | data_read | data_write | service_call | lib_import | component_use | util_call | config_read"
      nature: "Human-readable context"     # Optional
```

#### used_by

Reverse dependencies:

```yaml
relationships:
  used_by:
    - ref: "au:path/to/consumer"
      nature: "How it uses this"
```

#### related

Conceptual relationships:

```yaml
relationships:
  related:
    - ref: "au:path/to/related"
      nature: "Why related"
```

#### calls (file only)

Explicit call chain for flow tracing:

```yaml
relationships:
  calls:
    - ref: "au:path/to/service"
      method: "methodName"
      when: "Under what conditions"
      data_passed: "DataType"
```

#### emits (file only)

Events this file emits:

```yaml
relationships:
  emits:
    - event: "event.name"
      payload: "PayloadType"
      when: "Trigger condition"
      consumed_by:
        - "au:path/to/consumer"
```

#### triggered_by (file only)

Events this file handles:

```yaml
relationships:
  triggered_by:
    - event: "event.name"
      emitted_by: "au:path/to/emitter"
      payload: "PayloadType"
```

#### implements (file only)

API contract implementation:

```yaml
relationships:
  implements:
    - ref: "au:path/to/contract"
      endpoints: ["/api/path"]
```

#### generates (file only)

Code generation relationships:

```yaml
relationships:
  generates:
    - ref: "au:path/to/generated"
      nature: "What is generated"
```

---

### parent

**Applies to:** directory, file

Reference to parent directory:

```yaml
parent: "au:parent/path/"
```

---

### uncertainty

**Applies to:** primarily file, can be used in directory/repository

Documents areas of uncertainty:

```yaml
uncertainty:
  level: "low | medium | high"
  areas:
    - aspect: "What is uncertain"
      reason: "Why"
      suggestion: "How to resolve"
```

---

### entry_points

**Applies to:** repository only

Documents how users and systems enter the application:

```yaml
entry_points:
  user_actions:
    - action: "User clicks login button"
      starts_at: "au:src/components/LoginButton"
      flow: "login-flow"

  api_endpoints:
    - endpoint: "POST /api/auth/login"
      handler: "au:src/api/auth/login"
      flow: "login-flow"

  async_triggers:
    - trigger: "user.registered"
      handler: "au:src/workers/sendWelcomeEmail"
      flow: "welcome-email-flow"
```

---

### flows

**Applies to:** repository only

Documents business flows through the system:

```yaml
flows:
  - id: "login-flow"
    name: "User Login"
    description: "Authenticates user and creates session"
    trigger: "User submits login form"

    actors:
      - "User"
      - "Auth Service"

    preconditions:
      - "User has valid credentials"

    steps:
      - order: 1
        layer: "api"
        component: "au:src/api/auth/login"
        action: "Validate credentials"
        data_in: "LoginRequest"
        data_out: "AuthToken"
        middleware: ["rate-limit", "validate"]
        calls: ["au:src/services/auth"]
        emits: "user.logged_in"
        async: false

    error_paths:
      - id: "invalid-credentials"
        condition: "Credentials don't match"
        at_step: 1
        handling: ["Return 401"]
        response:
          http_status: 401
          body: "{ error: 'Invalid credentials' }"
        ui_result: "Show error message"

    side_effects:
      - effect: "Session created in database"
        permanent: true
        rollback: "Delete session record"

    postconditions:
      - "User has valid session token"
```

---

### data_contracts

**Applies to:** repository only

Shared data shapes used across flows:

```yaml
data_contracts:
  - id: "LoginRequest"
    description: "User login credentials"
    shape: |
      {
        email: string,
        password: string
      }
    used_in_flows: ["login-flow"]
    defined_in: "au:src/types/auth"
    validated_by: "au:src/validators/auth"
```

---

## References Format

### Internal references (au: prefix)

Reference other AU-documented paths:

```yaml
ref: "au:src/lib/auth"          # Directory
ref: "au:src/utils/hash.ts"     # File
```

### External references (lib: prefix)

Reference external libraries:

```yaml
ref: "lib:lodash"
ref: "lib:@prisma/client"
```

---

## Path Notation

The `setByPath` and `deleteByPath` operations use dot notation:

| Path | Target |
|------|--------|
| `""` or `"."` | Root document |
| `"understanding"` | Top-level `understanding` key |
| `"understanding.summary"` | Nested `summary` key |
| `"understanding.exports.0"` | First element of `exports` array |
| `"understanding.exports.0.name"` | `name` in first export |

Array indices that exceed length append to the end:
```
setByPath(doc, "items.10", "value")  # Appends if array has < 11 items
```

The `meta` path is protected and cannot be set or deleted directly.

---

## Validation Rules

The validator checks for:

### Required Fields

| Document Type | Required Fields |
|---------------|-----------------|
| All | `layer`, `understanding.summary` |
| File | `understanding.purpose` |
| File (service/util) | `understanding.key_logic` |
| Directory | `understanding.responsibility`, `contents` |
| Repository | `understanding.architecture` |

### Validation Checks

1. **Uncovered** - Source files/directories without corresponding .au files
2. **Contents mismatch** - Directory .au `contents` doesn't match actual directory
3. **Orphans** - .au files whose source no longer exists
4. **Stale** - .au files where `analyzed_hash` doesn't match current source
5. **Stale references** - `au:` references pointing to non-existent paths
6. **Incomplete** - .au files missing required fields

---

## Complete Examples

### Repository (.au)

```yaml
meta:
  au: "1.0"
  id: "au:"
  type: "repository"
  analyzed_at: "2025-01-08T15:00:00Z"
  analyzed_hash: "abc123"

understanding:
  name: "My API"
  summary: |
    A REST API for user management and authentication.
  purpose: |
    Provides backend services for the web application.
  architecture:
    style: "Monolith"
    layers:
      - name: "API"
        path: "src/api/"
        description: "HTTP endpoints and request handling"
      - name: "Services"
        path: "src/services/"
        description: "Business logic"
      - name: "Repository"
        path: "src/repositories/"
        description: "Data access"
  stack:
    language: "TypeScript 5.x"
    runtime: "Node 20"
    framework: "Express"
    database: "PostgreSQL"
  conventions:
    file_naming: "kebab-case"
  critical_areas:
    - path: "src/services/auth/"
      reason: "Security-critical authentication logic"

topics:
  - "api"
  - "authentication"
  - "user-management"

entry_points:
  api_endpoints:
    - endpoint: "POST /api/auth/login"
      handler: "au:src/api/auth/login"
      flow: "login-flow"

flows:
  - id: "login-flow"
    name: "User Login"
    description: "Authenticates user and creates session"
    trigger: "POST /api/auth/login"
    steps:
      - order: 1
        layer: "api"
        component: "au:src/api/auth/login"
        action: "Validate and authenticate"
        data_in: "LoginRequest"
        data_out: "AuthResponse"

data_contracts:
  - id: "LoginRequest"
    description: "Login credentials"
    shape: |
      { email: string, password: string }
    used_in_flows: ["login-flow"]
```

### Directory (src/services/.au)

```yaml
meta:
  au: "1.0"
  id: "au:src/services"
  type: "directory"
  analyzed_at: "2025-01-08T15:00:00Z"
  analyzed_hash: "def456"

layer: "service"

understanding:
  summary: |
    Business logic services for the application.
  responsibility: |
    Contains all business logic, orchestrating data access and external calls.
  design_principles:
    - "Each service owns a single domain"
    - "Services don't call each other directly"

contents:
  - name: "auth/"
    summary: "Authentication and authorization logic"
  - name: "user/"
    summary: "User management operations"
  - name: "index.ts"
    summary: "Service barrel exports"

topics:
  - "business-logic"
  - "services"

parent: "au:src"
```

### File (src/services/auth/login.ts.au)

```yaml
meta:
  au: "1.0"
  id: "au:src/services/auth/login.ts"
  type: "file"
  analyzed_at: "2025-01-08T15:00:00Z"
  analyzed_hash: "789ghi"

layer: "service"

behaviors:
  has_side_effects: true
  is_transactional: false
  concurrency_strategy: "none"

understanding:
  summary: |
    Handles user login authentication.
  purpose: |
    Validates credentials and creates authenticated sessions.
  exports:
    - name: "loginUser"
      kind: "function"
      signature: "(email: string, password: string) => Promise<AuthResult>"
      description: "Authenticates user and returns session token"
  key_logic: |
    1. Looks up user by email
    2. Verifies password hash using bcrypt
    3. Creates session token with JWT
    4. Logs authentication event
  edge_cases:
    - scenario: "User not found"
      behavior: "Returns generic 'invalid credentials' to prevent enumeration"
    - scenario: "Account locked"
      behavior: "Returns locked error with unlock time"
  constraints:
    - "Password must be at least 8 characters"
    - "Account locks after 5 failed attempts"

topics:
  - "authentication"
  - "security"
  - "login"

questions_answered:
  - "How does user login work?"
  - "What happens on failed login?"
  - "How are passwords verified?"

relationships:
  depends_on:
    - ref: "au:src/repositories/user"
      symbols: ["findByEmail"]
      kind: "data_read"
    - ref: "lib:bcrypt"
      kind: "lib_import"
  calls:
    - ref: "au:src/repositories/user"
      method: "findByEmail"
      when: "Looking up user"
      data_passed: "email string"
  emits:
    - event: "auth.login.success"
      payload: "{ userId: string }"
      when: "Login succeeds"
    - event: "auth.login.failed"
      payload: "{ email: string, reason: string }"
      when: "Login fails"

parent: "au:src/services/auth"

uncertainty:
  level: "low"
```
