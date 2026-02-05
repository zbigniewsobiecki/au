/**
 * SysML v2 generation utilities.
 * Provides functions for generating SysML v2 code from discovered project metadata.
 */

import type { ProjectMetadata, ExternalDependency } from "./discovery.js";
import { listElements } from "./sysml2-cli.js";

/**
 * Escape a string for use in SysML.
 */
export function escapeSysmlString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Convert a path to a valid SysML identifier.
 */
export function pathToIdentifier(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Generate indentation.
 */
export function indent(level: number): string {
  return "    ".repeat(level);
}

/**
 * Format a SysML doc comment.
 * Uses double asterisk /** ... * / syntax for parser compatibility (distinguishes from regular comments).
 */
export function formatDocComment(text: string, indentLevel: number = 0): string {
  const prefix = indent(indentLevel);
  const lines = text.split("\n");
  if (lines.length === 1) {
    return `${prefix}doc /* ${text} */`;
  }
  return `${prefix}doc /*\n${lines.map((l) => `${prefix} * ${l}`).join("\n")}\n${prefix} */`;
}

/**
 * Generate the SysML stdlib file.
 * Self-contained standard library - all types in one package with no external dependencies.
 */
export function generateStdlib(): string {
  return `standard library package SysMLPrimitives {
    doc /*
     * AU SysML v2 Primitives for software project modeling.
     * Self-contained - no external dependencies required.
     * All model files should import SysMLPrimitives::* to access these types.
     */

    // ========== PRIMITIVE DATATYPES ==========
    // These can be used to type attributes: \`attribute x : String;\`
    datatype String;
    datatype Integer;
    datatype Real;
    datatype Boolean;
    datatype DateTime;
    datatype Duration;
    datatype Identifier;
    datatype URL;
    datatype FilePath;
    datatype JSON;

    // ========== BASE ITEM TYPES ==========
    // IMPORTANT: Use BaseEntity, BaseDTO, BaseDomainEvent - NOT Item directly

    abstract item def Item {
        doc /*Internal base - do NOT extend directly. Use BaseEntity, BaseDTO, etc. */
    }

    item def BaseEntity :> Item {
        doc /*Extend for domain entities: item def User :> BaseEntity { ... } */
        attribute id : Identifier;
        attribute createdAt : DateTime [0..1];
        attribute updatedAt : DateTime [0..1];
    }

    item def BaseDTO :> Item {
        doc /*Extend for DTOs: item def CreateUserRequest :> BaseDTO { ... } */
    }

    item def BaseDomainEvent :> Item {
        doc /*Extend for events: item def UserCreated :> BaseDomainEvent { ... } */
        attribute eventId : Identifier;
        attribute eventType : String;
        attribute timestamp : DateTime;
    }

    item def AnyItem :> Item {
        doc /*Concrete marker for polymorphic item fields.
             Use when a field can hold any item type (e.g., API response data).
             Example: item data : AnyItem [0..1]; */
    }

    // ========== BASE REQUIREMENT TYPE ==========
    requirement def BaseRequirement {
        doc /*Extend for requirements: requirement def FR001 :> BaseRequirement { ... } */
        attribute id : Identifier;
        attribute source : String [0..1];
        attribute priority : String [0..1];
    }

    // ========== BASE PART TYPES ==========
    abstract part def Part {
        doc /*Base for system components */
    }

    part def Module :> Part {
        doc /*Software module */
        attribute path : FilePath;
        attribute layer : String;
    }

    // ========== PORT TYPES ==========
    abstract port def Port {
        doc /*Base connection point */
    }

    port def DataPort :> Port {
        doc /*Data exchange port */
    }

    port def EventPort :> Port {
        doc /*Event emission port */
    }

    port def ServicePort :> Port {
        doc /*Service interface port */
    }

    // ========== CONNECTIONS ==========
    connection def DataFlow {
        end source;
        end target;
    }

    connection def ServiceBinding {
        end client;
        end server;
    }

    // ========== ALLOCATIONS ==========
    allocation def Implements {
        end requirement;
        end implementation;
    }

    allocation def BehaviorToModule {
        doc /*Maps behavior definitions to module implementations */
        end behavior;
        end module;
    }

    // ========== METADATA ==========
    // Usage: @SourceFile { :>> path = "src/file.ts"; :>> line = 42; }
    // Or prefix: #SourceFile { :>> path = "src/file.ts"; }
    metadata def SourceFile {
        attribute path : FilePath;
        attribute line : Integer;
    }

    // Stereotype markers - use with semicolon: @external; or prefix: #external
    metadata def external;
    metadata def internal;
    metadata def Deprecated;
    metadata def SecurityCritical;
    metadata def PerformanceCritical;
    metadata def Async;

    // ========== ACCESS CONTROL TYPES ==========
    abstract item def Role :> Item {
        doc /*Base for role definitions */
        attribute name : String;
        attribute description : String [0..1];
    }

    item def Permission :> Item {
        doc /*Permission definition */
        attribute action : String;
        attribute resource : String;
    }

    part def AccessPolicy :> Part {
        doc /*Access control policy mapping roles to permissions */
        attribute isPublic : Boolean;
        attribute requiresAuth : Boolean;
        attribute allowedRoles : String [0..*];
    }

    allocation def RolePermission {
        doc /*Maps roles to permissions */
        end role;
        end permission;
    }

    // ========== COMMON ENUMS ==========
    enum def LifecycleStatus {
        Draft;
        Active;
        Deprecated;
        Archived;
    }

    // ========== CONSTRAINT PATTERNS ==========
    constraint def NotNull {
        doc /*Value must not be null */
    }

    constraint def NotEmpty {
        doc /*String/collection must not be empty */
    }

    constraint def Positive {
        doc /*Number must be greater than zero */
    }

    constraint def NonNegative {
        doc /*Number must be greater than or equal to zero */
    }

    constraint def LatencyBound {
        doc /*Response time must be within limit */
        in measured : Real;
        in limit : Real;
        measured <= limit
    }

    constraint def ValidRange {
        doc /*Value must be within min/max bounds */
        in value : Real;
        in minVal : Real;
        in maxVal : Real;
        value >= minVal and value <= maxVal
    }

    // ========== BUSINESS CONSTRAINT TYPES ==========
    constraint def UniqueConstraint {
        doc /*Field value must be unique across all records */
    }

    constraint def PatternConstraint {
        doc /*Value must match a regex pattern */
        in pattern : String;
    }

    constraint def LengthConstraint {
        doc /*String length must be within bounds */
        in minLength : Integer;
        in maxLength : Integer;
    }

    constraint def EmailFormat :> PatternConstraint {
        doc /*Must be valid email format */
    }

    constraint def RequiredConstraint :> NotNull {
        doc /*Field is required (alias for NotNull) */
    }

    // ========== APPLICATION COMPONENTS ==========
    abstract part def Application :> Part {
        doc /*Base for all application types */
        attribute name : String;
        attribute version : String [0..1];
    }

    part def WebApplication :> Application {
        doc /*Full-stack web application */
        part frontend : Frontend [0..1];
        part backend : Backend [0..1];
        part database [0..*];
    }

    part def Frontend :> Part {
        doc /*Client-side application (SPA, SSR, static) */
        attribute framework : String;
        attribute port : Integer [0..1];
        port api : ~HTTPPort;
    }

    part def Backend :> Part {
        doc /*Server-side application */
        attribute framework : String;
        attribute port : Integer [0..1];
        port api : HTTPPort;
        port db : ~DatabasePort;
    }

    part def APIServer :> Backend {
        doc /*REST/GraphQL API server */
        attribute basePath : String [0..1];
    }

    part def Worker :> Part {
        doc /*Background worker process */
        attribute queue : String [0..1];
        port tasks : ~MessagePort;
    }

    // ========== DATABASE & STORAGE ==========
    abstract part def Database :> Part {
        doc /*Base for all database types */
        attribute name : String [0..1];
        attribute purpose : String [0..1];
        attribute host : String [0..1];
        attribute port : Integer [0..1];
        attribute connectionString : String [0..1];
        port connection : DatabasePort;
    }

    part def PostgreSQL :> Database {
        doc /*PostgreSQL database */
    }

    part def MySQL :> Database {
        doc /*MySQL database */
    }

    part def MongoDB :> Database {
        doc /*MongoDB database */
    }

    part def Redis :> Part {
        doc /*Redis cache/store */
        attribute host : String [0..1];
        attribute port : Integer [0..1];
        port connection : CachePort;
    }

    part def S3Storage :> Part {
        doc /*S3-compatible object storage */
        attribute bucket : String;
        attribute region : String [0..1];
        port storage : StoragePort;
    }

    // ========== EXTERNAL INTEGRATIONS ==========
    abstract part def ExternalService :> Part {
        doc /*Third-party service integration */
        attribute provider : String;
        attribute apiKey : String [0..1];
    }

    part def AuthProvider :> ExternalService {
        doc /*Authentication provider (Auth0, Clerk, etc.) */
        port auth : AuthPort;
    }


    // ========== SERVICE PORTS ==========
    port def HTTPPort :> ServicePort {
        doc /*HTTP/REST API port */
        attribute basePath : String [0..1];
        attribute port : Integer [0..1];
        in item request : HTTPRequest [0..*];
        out item response : HTTPResponse [0..*];
    }

    port def WebSocketPort :> Port {
        doc /*WebSocket connection port */
        in item inMessage : Message [0..*];
        out item outMessage : Message [0..*];
    }

    port def DatabasePort :> Port {
        doc /*Database connection port */
        in item query : Query [0..*];
        out item result : QueryResult [0..*];
    }

    port def CachePort :> Port {
        doc /*Cache connection port */
        in item cacheKey [0..*];
        out item cacheValue [0..1];
    }

    port def MessagePort :> Port {
        doc /*Message queue port */
        in item inMessage : Message [0..*];
        out item acknowledgement [0..1];
    }

    port def AuthPort :> Port {
        doc /*Authentication port */
        in item credentials : Credentials;
        out item token : AuthToken [0..1];
    }

    port def StoragePort :> Port {
        doc /*File storage port */
        in item file : FileData;
        out item fileUrl [0..1];
    }

    // ========== API ITEM TYPES ==========
    item def HTTPRequest :> BaseDTO {
        doc /*HTTP request */
        attribute method : String;
        attribute path : String;
        attribute headers : JSON [0..1];
        attribute body : JSON [0..1];
    }

    item def HTTPResponse :> BaseDTO {
        doc /*HTTP response */
        attribute statusCode : Integer;
        attribute headers : JSON [0..1];
        attribute body : JSON [0..1];
    }

    // ========== API ENDPOINT TYPES ==========
    enum def HTTPMethod {
        doc /*Standard HTTP methods */
        GET;
        POST;
        PUT;
        DELETE;
        PATCH;
        OPTIONS;
        HEAD;
    }

    item def APIEndpoint :> BaseDTO {
        doc /*API endpoint definition with HTTP semantics */
        attribute method : HTTPMethod;
        attribute path : String;
        attribute pathParams : String [0..*];
        attribute queryParams : String [0..*];
        attribute requiresAuth : Boolean;
        attribute requiredRoles : String [0..*];
    }

    item def Message :> Item {
        doc /*Generic message */
        attribute payload : JSON;
        attribute timestamp : DateTime;
    }

    item def Query :> Item {
        doc /*Database query */
        attribute sql : String [0..1];
        attribute params : JSON [0..1];
    }

    item def QueryResult :> Item {
        doc /*Database query result */
        attribute rows : JSON;
        attribute rowCount : Integer;
    }

    // ========== QUERY & FILTER TYPES ==========
    enum def SortOrder {
        doc /*Sort direction for queries */
        Asc;
        Desc;
    }

    enum def FilterOperator {
        doc /*Filter comparison operators */
        Eq;         // equals
        Ne;         // not equals
        Gt;         // greater than
        Gte;        // greater than or equal
        Lt;         // less than
        Lte;        // less than or equal
        Contains;   // string contains
        StartsWith; // string starts with
        EndsWith;   // string ends with
        In;         // value in list
        NotIn;      // value not in list
        IsNull;     // is null
        IsNotNull;  // is not null
    }

    item def PaginationParams :> BaseDTO {
        doc /*Standard pagination parameters */
        attribute page : Integer;
        attribute pageSize : Integer;
        attribute sortBy : String [0..1];
        attribute sortOrder : SortOrder [0..1];
    }

    item def FilterParam :> BaseDTO {
        doc /*Single filter parameter */
        attribute field : String;
        attribute operator : FilterOperator;
        attribute value : String;
    }

    item def PaginatedResponse :> BaseDTO {
        doc /*Paginated response wrapper */
        item data : AnyItem [0..*];
        attribute total : Integer;
        attribute page : Integer;
        attribute pageSize : Integer;
        attribute totalPages : Integer;
    }

    item def Credentials :> BaseDTO {
        doc /*Authentication credentials */
        attribute email : String [0..1];
        attribute password : String [0..1];
        attribute token : String [0..1];
    }

    item def AuthToken :> BaseDTO {
        doc /*Authentication token */
        attribute accessToken : String;
        attribute refreshToken : String [0..1];
        attribute expiresAt : DateTime [0..1];
    }

    item def FileData :> BaseDTO {
        doc /*File data for storage */
        attribute name : String;
        attribute contentType : String [0..1];
        attribute size : Integer [0..1];
    }

    // ========== CONNECTION DEFINITIONS ==========
    connection def APIConnection :> ServiceBinding {
        doc /*Frontend to Backend API connection */
        end client : ~HTTPPort;
        end server : HTTPPort;
    }

    connection def DatabaseConnection {
        doc /*Application to Database connection */
        end app : ~DatabasePort;
        end db : DatabasePort;
    }

    connection def CacheConnection {
        doc /*Application to Cache connection */
        end app : ~CachePort;
        end cache : CachePort;
    }
}
`;
}

/**
 * Generate the project metadata file.
 */
export function generateProjectFile(metadata: ProjectMetadata): string {
  const metaJson = JSON.stringify(metadata, null, 2).replace(/\*\//g, "* /");

  return `package ProjectMetadata {
    import SysMLPrimitives::*;

    doc /*Project Metadata. Auto-discovered from ${escapeSysmlString(metadata.manifestFile ?? "codebase analysis")}. Project: ${escapeSysmlString(metadata.name)} */
    comment /* META: ${metaJson} */

    // Project identification
    attribute projectName : String = "${escapeSysmlString(metadata.name)}";
    attribute projectVersion : String = "${escapeSysmlString(metadata.version ?? "0.0.0")}";
    attribute projectDescription : String = "${escapeSysmlString(metadata.description)}";

    // Technology stack
    attribute projectType : String = "${metadata.projectType}";
    attribute primaryLanguage : String = "${metadata.primaryLanguage}";
    attribute runtime : String = "${escapeSysmlString(metadata.runtime ?? "unknown")}";
    ${metadata.framework ? `attribute framework : String = "${escapeSysmlString(metadata.framework)}";` : "// No specific framework detected"}

    // Architecture
    attribute architectureStyle : String = "${metadata.architectureStyle}";

    // Discovery timestamp
    attribute discoveredAt : DateTime = "${metadata.discoveredAt}";
}
`;
}

/**
 * Generate external dependency definition.
 */
function generateExternalDependency(dep: ExternalDependency, indentLevel: number): string {
  const prefix = indent(indentLevel);
  const id = pathToIdentifier(dep.name.toLowerCase());

  return `${prefix}part ${id} : ExternalDependency {
${prefix}    :>> name = "${escapeSysmlString(dep.name)}";
${prefix}    :>> purpose = "${escapeSysmlString(dep.purpose)}";
${prefix}    :>> dependencyType = "${dep.type}";
${prefix}    ${dep.version ? `:>> version = "${escapeSysmlString(dep.version)}";` : ""}
${prefix}}`;
}

/**
 * Generate the system context package (Cycle 1).
 */
export function generateSystemContext(metadata: ProjectMetadata): string {
  const externalDeps = metadata.externalDependencies
    .map((dep) => generateExternalDependency(dep, 2))
    .join("\n\n");

  const portDefs: string[] = [];
  if (metadata.ports.http) portDefs.push("        port httpApi;");
  if (metadata.ports.grpc) portDefs.push("        port grpcApi;");
  if (metadata.ports.cli) portDefs.push("        port cliInterface;");
  if (metadata.ports.websocket) portDefs.push("        port websocketApi;");
  if (metadata.ports.tcp) portDefs.push("        port tcpSocket;");
  if (metadata.ports.embedded) portDefs.push("        port embeddedIO;");

  return `package SystemContext {
    import SysMLPrimitives::*;
    import ProjectMetadata::*;

    doc /*System Context. Defines the system boundary and external dependencies. Discovered from ${escapeSysmlString(metadata.manifestFile ?? "codebase analysis")}. System context for ${escapeSysmlString(metadata.name)} */

    // External dependency definition
    part def ExternalDependency {
        attribute name : String;
        attribute purpose : String;
        attribute dependencyType : String;
        attribute version : String [0..1];
    }

${externalDeps}

    // System boundary
    part def System {
        doc /*The ${escapeSysmlString(metadata.name)} system */

        // Application entry points
${metadata.entryPoints
  .filter(ep => ep.startsWith("apps/"))
  .map((ep) => `        attribute appEntryPoint_${pathToIdentifier(ep)} : FilePath = "${escapeSysmlString(ep)}";`)
  .join("\n") || "        // No application entry points discovered"}

        // Library entry points (for reference)
${metadata.entryPoints
  .filter(ep => ep.startsWith("packages/"))
  .map((ep) => `        attribute libEntryPoint_${pathToIdentifier(ep)} : FilePath = "${escapeSysmlString(ep)}";`)
  .join("\n") || "        // No library entry points discovered"}

        // System ports (discovered interfaces)
${portDefs.length > 0 ? portDefs.join("\n") : "        // No ports discovered"}
    }

    // Instantiate the system
    part system : System;
}
`;
}

/**
 * Generate initial requirements package (Cycle 1).
 * Note: BaseRequirement is defined in SysMLPrimitives stdlib.
 */
export function generateRequirements(metadata: ProjectMetadata): string {
  return `package SystemRequirements {
    import SysMLPrimitives::*;

    doc /*System Requirements. Requirements extracted from documentation and codebase analysis for ${escapeSysmlString(metadata.name)}. Use BaseRequirement from SysMLPrimitives as the base type for all requirements. */

    // Functional requirements (to be populated by analysis)
    // Example: requirement def FR001 :> BaseRequirement { :>> id = "FR-001"; doc /* ... */ }
    package FunctionalRequirements {
        doc /*Functional requirements discovered from documentation */
    }

    // Non-functional requirements (to be populated by analysis)
    // Example: requirement def NFR001 :> BaseRequirement { :>> id = "NFR-001"; doc /* ... */ }
    package NonFunctionalRequirements {
        doc /*Non-functional requirements discovered from documentation */
    }
}
`;
}

/**
 * Generate module structure template (Cycle 2).
 */
export function generateStructureTemplate(): string {
  return `package SystemArchitecture {
    import SysMLPrimitives::*;
    import SystemContext::*;

    doc /*System Architecture. Module structure and organization discovered from codebase analysis. */

    // Architecture style (to be set by analysis)
    attribute architectureStyle : String;

    // Base module definition - extends Part for standard library compatibility
    part def Module :> Part {
        doc /*Base module - aligns with Parts::Part */
        attribute path : FilePath;
        attribute responsibility : String;
        attribute layer : String [0..1];
    }

    // Service module with standard ports
    part def ServiceModule :> Module {
        doc /*Module that exposes a service interface */
        port api : ServicePort;
        port events : EventPort [0..1];
    }

    // Data module with database connectivity
    part def DataModule :> Module {
        doc /*Module that manages data persistence */
        port data : DataPort;
    }

    // Interface definitions for module contracts
    interface def ModuleInterface {
        doc /*Contract between module provider and consumer */
        end provider;
        end consumer;
    }

    interface def ServiceInterface {
        doc /*Service contract with typed endpoints */
        end server : ServicePort;
        end client : ~ServicePort;
    }

    interface def ItemFlowInterface {
        doc /*Template: interface with explicit item flows (E2E Step 2) */
        end provider : ServicePort;
        end consumer : ~ServicePort;
    }

    // Connection patterns
    connection def ModuleConnection {
        doc /*Standard connection between modules */
        end source;
        end target;
    }

    // System decomposition (to be populated by analysis)
    part def SystemDecomposition {
        doc /*System broken down into modules */
    }

    part decomposition : SystemDecomposition;
}
`;
}

/**
 * Generate data model template (Cycle 3).
 * Optionally includes entity stubs and auth types based on discovered entities/domains.
 */
export function generateDataModelTemplate(
  discoveredEntities?: string[],
  discoveredDomains?: string[]
): string {
  // Generate entity stubs
  const entityStubs = (discoveredEntities ?? []).map(name => `
        // Stub - attributes populated in Cycle 3
        item def ${name} :> BaseEntity {
            doc /* ${name} domain entity */
        }

        item def Create${name}Dto :> BaseDTO {
            doc /* Request DTO for creating a ${name} */
        }

        item def Update${name}Dto :> BaseDTO {
            doc /* Request DTO for updating a ${name} */
        }`).join('\n');

  // Generate auth types if auth domain discovered
  const hasAuth = (discoveredDomains ?? []).some(d =>
    d.toLowerCase() === 'auth'
  );

  const authStubs = hasAuth ? `
        // Authentication types - stub for Cycle 2 ports
        item def LoginRequest :> BaseDTO {
            doc /* Login credentials */
        }

        item def AuthResponse :> BaseDTO {
            doc /* Authentication response with token */
        }

        item def TokenPayload :> BaseDTO {
            doc /* JWT token payload */
        }` : '';

  return `package DataModel {
    import SysMLPrimitives::*;

    doc /*Data Model. Domain entities, data transfer objects, and enumerations. Data structures discovered from type definitions and schemas. */

    // Base entity with common attributes - extends Item for standard library compatibility
    item def BaseEntity :> Item {
        doc /*Common base for domain entities. Aligns with Items::Item. */
        attribute id : Identifier;
        attribute createdAt : DateTime;
        attribute updatedAt : DateTime;
    }

    // Base DTO for API transfers - extends Item
    item def BaseDTO :> Item {
        doc /*Common base for data transfer objects. Aligns with Items::Item. */
    }

    // Base event for domain events - extends Item
    item def BaseDomainEvent :> Item {
        doc /*Common base for domain events. Aligns with Items::Item. */
        attribute eventId : Identifier;
        attribute timestamp : DateTime;
        attribute eventType : String;
    }

    // Relationship template for entity connections
    connection def EntityRelation {
        doc /*Template for entity relationships */
        end source [1];
        end target [0..*];
    }

    // Entity definitions (to be populated by analysis)
    package Entities {
        import DataModel::*;
${entityStubs || '        // No entities discovered - populated in Cycle 3'}
    }

    // Data transfer objects (to be populated by analysis)
    package DTOs {
        import DataModel::*;
${authStubs || '        // Auth types populated in Cycle 3'}
    }

    // Events (to be populated by analysis)
    package Events {
        doc /*Domain events - specialize from BaseDomainEvent */
    }

    // Enumerations (to be populated by analysis)
    package Enums {
        doc /*Enumeration types */
    }
}
`;
}

/**
 * Generate behavior template (Cycle 4).
 */
export function generateBehaviorTemplate(): string {
  return `package SystemBehavior {
    import SysMLPrimitives::*;
    import DataModel::*;
    import SystemArchitecture::*;

    doc /*System Behavior. Operations, state machines, and event handlers. Behavioral aspects of the system. */

    // State machine template with transitions
    state def EntityLifecycle {
        doc /*Template for entity state machines */

        entry;
        state Initial;
        state Processing;
        state Completed;
        state Error;

        transition first entry then Initial;
        transition first Initial then Processing;
        transition first Processing then Completed;
        transition first Processing then Error;
    }

    // Operation template with flow pattern
    action def Operation {
        doc /*Template for system operations with data flow */

        in input;
        out output;
        out error [0..1];

        action validate { out validated; }
        action process { in data; out result; }
        action respond { in result; }

        // Data flows between steps
        flow from input to validate;
        flow from validate.validated to process.data;
        flow from process.result to respond.result;
        flow from respond to output;

        // Control flow sequencing
        first validate then process;
        first process then respond;
    }

    // E2E feature flow template (Step 1 of 3-step pattern)
    action def E2EFlowTemplate {
        doc /*Template for E2E feature flows (Step 1 of 3-step pattern) */

        in request; out response; out error [0..1];

        action validate { in data; out validated; }
        action execute { in validated; out result; }
        action respond { in result; out response; }

        flow from request to validate.data;
        flow from validate.validated to execute.validated;
        flow from execute.result to respond.result;
        flow from respond.response to response;

        first validate then execute;
        first execute then respond;
    }

    // Event handler template
    action def EventHandler {
        doc /*Template for event-driven operations */

        in event;

        action handle { in eventData; out result; }
        action notify { in result; }

        flow from event to handle.eventData;
        flow from handle.result to notify.result;

        first handle then notify;
    }

    // Operations (to be populated by analysis)
    package Operations {
        doc /*System operations discovered from handlers/controllers */
    }

    // State machines (to be populated by analysis)
    package StateMachines {
        doc /*State machines discovered from code patterns */
    }

    // Event handlers (to be populated by analysis)
    package EventHandlers {
        doc /*Event handlers discovered from code */
    }

    // System-level operations with data flows
    package SystemOperations {
        import SysMLPrimitives::*;
        import DataModel::*;
        doc /*System operations/actions with data flows */
    }

    // Service-level behavioral definitions
    package ServiceBehaviors {
        import SysMLPrimitives::*;
        import SystemArchitecture::*;
        doc /*Service-level behavioral definitions */
    }

    // Entity lifecycle state machines
    package EntityStateMachines {
        import SysMLPrimitives::*;
        import DataModel::*;
        doc /*Entity lifecycle state machines */
    }

    // Domain event definitions
    package DomainEvents {
        import SysMLPrimitives::*;
        import DataModel::*;
        doc /*Domain event definitions */
    }
}
`;
}

/**
 * Generate verification template (Cycle 5).
 *
 * Note: TestMappings and CoverageAnalysis are created as sibling packages
 * in separate files during Cycle 5. This template only provides the base
 * definitions to avoid E3003 "undefined namespace" errors when the agent
 * tries to import packages before creating them.
 */
export function generateVerificationTemplate(): string {
  return `package Verification {
    import SysMLPrimitives::*;
    import SystemRequirements::*;
    import SystemBehavior::*;

    doc /*Verification. Test coverage and requirement traceability. Base definitions for verification modeling. TestMappings and CoverageAnalysis packages are created as sibling files during Cycle 5. */

    // Test category enumeration
    enum def TestCategory {
        Unit;
        Integration;
        E2E;
        Performance;
        Security;
        Smoke;
        Regression;
    }

    // Test case definition - base type for all test cases
    verification def TestCase {
        doc /*Base verification definition for test cases */
        attribute testFile : FilePath;
        attribute testName : String;
        attribute category : TestCategory;
        attribute description : String [0..1];
    }

    // Test coverage analysis template - attributes at top level so they can be redefined
    analysis def TestCoverage {
        doc /*Template for test coverage analysis. Specialize with :> and redefine with :>> */
        attribute testedOperations : Integer;
        attribute totalOperations : Integer;
        attribute coveragePercent : Real;
    }
}
`;
}

/**
 * Generate analysis template (Cycle 6).
 */
export function generateAnalysisTemplate(): string {
  return `package Analysis {
    import SysMLPrimitives::*;
    import SystemArchitecture::*;
    import SystemBehavior::*;

    doc /*Analysis. Non-functional analysis and system properties. System analysis and quality attributes. */

    // Performance analysis
    analysis def PerformanceProfile {
        subject system : System;

        attribute hasCaching : Boolean = false;
        attribute hasRateLimiting : Boolean = false;
        attribute hasAsyncProcessing : Boolean = false;
        attribute hasConnectionPooling : Boolean = false;

        results {
            attribute expectedLatencyMs : Real;
            attribute expectedThroughput : Real;
        }
    }

    // Reliability analysis
    analysis def ReliabilityProfile {
        attribute hasRetries : Boolean = false;
        attribute hasCircuitBreaker : Boolean = false;
        attribute hasGracefulDegradation : Boolean = false;
        attribute hasHealthChecks : Boolean = false;

        results {
            attribute failureHandling : String;
            attribute recoveryStrategy : String;
        }
    }

    // Security analysis
    analysis def SecurityProfile {
        attribute authenticationMethod : String;
        attribute authorizationModel : String;
        attribute hasInputValidation : Boolean = false;
        attribute hasEncryption : Boolean = false;
        attribute hasRateLimiting : Boolean = false;

        results {
            attribute securityPosture : String;
        }
    }

    // Observability analysis
    analysis def ObservabilityProfile {
        attribute hasLogging : Boolean = false;
        attribute hasMetrics : Boolean = false;
        attribute hasTracing : Boolean = false;
        attribute hasAlerting : Boolean = false;
    }

    // Performance constraint definitions
    constraint def ResponseTimeConstraint {
        doc /*Response time must be within acceptable limit */
        in measured : Real;
        in limit : Real;
        measured <= limit
    }

    constraint def ThroughputConstraint {
        doc /*Throughput must meet minimum requirement */
        in actual : Real;
        in minimum : Real;
        actual >= minimum
    }

    constraint def AvailabilityConstraint {
        doc /*Availability must meet SLA */
        in uptime : Real;
        in target : Real;
        uptime >= target
    }

    // Allocation definitions for traceability (E2E Step 3: Binding)
    package BehaviorAllocations {
        doc /*E2E Step 3: Allocation (Binding).
             Maps action defs to implementing modules.
             Use granular sub-action allocation: allocate ActionDef.subAction to Module. */

        allocation def OperationToModule :> BehaviorToModule {
            doc /*Maps operations to their implementing modules.
                 For E2E flows, allocate each sub-action separately:
                 allocate LoginE2E.validate to ApiGateway;
                 allocate LoginE2E.authenticate to AuthModule; */
        }
    }

    // Performance requirements
    package PerformanceConstraints {
        doc /*Performance constraints and assertions */
    }

    // Analysis instances (to be populated by analysis)
    package AnalysisResults {
        doc /*Concrete analysis results */
    }
}
`;
}

/**
 * Generate the master index file.
 */
export function generateModelIndex(metadata: ProjectMetadata): string {
  return `package ${pathToIdentifier(metadata.name)}Model {
    doc /*${escapeSysmlString(metadata.name)} - SysML v2 Model. Master index file importing all model packages. Generated: ${new Date().toISOString()}. Project Type: ${metadata.projectType}. Language: ${metadata.primaryLanguage}.${metadata.framework ? ` Framework: ${metadata.framework}.` : ""} */

    // Import all model packages by their package names
    import SysMLPrimitives::*;
    import ProjectMetadata::*;
    import SystemRequirements::*;
    import SystemContext::*;
    import SystemArchitecture::*;
    import DataModel::*;
    import SystemBehavior::*;
    import Verification::*;
    import Analysis::*;

    // Re-export key packages for convenience
    alias Requirements for SystemRequirements;
    alias Context for SystemContext;
    alias Architecture for SystemArchitecture;
    alias Data for DataModel;
    alias Behavior for SystemBehavior;
    alias Tests for Verification;
    alias QualityAnalysis for Analysis;
}
`;
}

/**
 * Generate all initial SysML files for a project.
 */
export interface GeneratedFiles {
  "SysMLPrimitives.sysml": string;
  "_project.sysml": string;
  "_model.sysml": string;
  "context/requirements.sysml": string;
  "context/boundaries.sysml": string;
  "structure/_index.sysml": string;
  "data/_index.sysml": string;
  "behavior/_index.sysml": string;
  "verification/_index.sysml": string;
  "analysis/_index.sysml": string;
}

export function generateInitialFiles(metadata: ProjectMetadata): GeneratedFiles {
  return {
    "SysMLPrimitives.sysml": generateStdlib(),
    "_project.sysml": generateProjectFile(metadata),
    "_model.sysml": generateModelIndex(metadata),
    "context/requirements.sysml": generateRequirements(metadata),
    "context/boundaries.sysml": generateSystemContext(metadata),
    "structure/_index.sysml": generateStructureTemplate(),
    "data/_index.sysml": generateDataModelTemplate(),
    "behavior/_index.sysml": generateBehaviorTemplate(),
    "verification/_index.sysml": generateVerificationTemplate(),
    "analysis/_index.sysml": generateAnalysisTemplate(),
  };
}

/**
 * Discover all top-level package names in the SysML directory.
 * Uses sysml2 --list to enumerate elements and filters for packages.
 */
export async function discoverModelPackages(sysmlDir: string): Promise<string[]> {
  const entries = await listElements([sysmlDir], { recursive: true, parseOnly: true });
  const packages = entries
    .filter((e) => e.kind === "package")
    .map((e) => e.name);
  return [...new Set(packages)].sort();
}

/**
 * Standard package aliases for known packages.
 */
const STANDARD_ALIASES: Record<string, string> = {
  SystemRequirements: "Requirements",
  SystemContext: "Context",
  SystemArchitecture: "Architecture",
  DataModel: "Data",
  SystemBehavior: "Behavior",
  Verification: "Tests",
  Analysis: "QualityAnalysis",
};

/**
 * Regenerate _model.sysml content with imports for all discovered packages.
 */
export async function regenerateModelIndex(
  sysmlDir: string,
  projectName: string
): Promise<string> {
  const packages = await discoverModelPackages(sysmlDir);

  // Generate imports for all packages
  const imports = packages
    .map((pkg) => `    import ${pkg}::*;`)
    .join("\n");

  // Generate aliases for known packages
  const aliases = packages
    .filter((pkg) => STANDARD_ALIASES[pkg])
    .map((pkg) => `    alias ${STANDARD_ALIASES[pkg]} for ${pkg};`)
    .join("\n");

  const modelName = pathToIdentifier(projectName);

  return `package ${modelName}Model {
    doc /*${escapeSysmlString(projectName)} - SysML v2 Model. Master index file importing all model packages. Generated: ${new Date().toISOString()}. */

    // Import all model packages by their package names
${imports}

    // Re-export key packages for convenience
${aliases}
}
`;
}
