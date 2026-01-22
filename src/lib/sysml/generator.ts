/**
 * SysML v2 generation utilities.
 * Provides functions for generating SysML v2 code from discovered project metadata.
 */

import type { ProjectMetadata, ExternalDependency } from "./discovery.js";

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
    return `${prefix}doc /** ${text} */`;
  }
  return `${prefix}doc /**\n${lines.map((l) => `${prefix} * ${l}`).join("\n")}\n${prefix} */`;
}

/**
 * Generate the SysML stdlib file.
 */
export function generateStdlib(): string {
  return `standard library package SysMLPrimitives {
    doc /**SysML v2 Standard Library Primitives. Provides base types and common definitions for the model. */

    // Primitive value types
    datatype String;
    datatype Integer;
    datatype Real;
    datatype Boolean;
    datatype DateTime;
    datatype Duration;

    // Common identifier type
    datatype Identifier :> String;

    // URL type for references
    datatype URL :> String;

    // Path type for file references
    datatype FilePath :> String;

    // Common units
    attribute def Milliseconds :> Duration;
    attribute def Seconds :> Duration;
    attribute def Minutes :> Duration;

    // Stereotypes (annotations)
    metadata def external;
    metadata def internal;
    metadata def deprecated;
    metadata def required;
    metadata def optional;

    // Common enumeration for status
    enum def Status {
        Pending;
        InProgress;
        Completed;
        Failed;
        Cancelled;
    }

    // Common constraint patterns
    constraint def NotNull {
        doc /**Value must not be null */
    }

    constraint def NotEmpty {
        doc /**String/collection must not be empty */
    }

    constraint def Positive {
        doc /**Number must be greater than zero */
    }

    constraint def NonNegative {
        doc /**Number must be greater than or equal to zero */
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

    doc /**Project Metadata. Auto-discovered from ${escapeSysmlString(metadata.manifestFile ?? "codebase analysis")}. Project: ${escapeSysmlString(metadata.name)} */
    comment /** META: ${metaJson} */

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

    doc /**System Context. Defines the system boundary and external dependencies. Discovered from ${escapeSysmlString(metadata.manifestFile ?? "codebase analysis")}. System context for ${escapeSysmlString(metadata.name)} */

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
        doc /**The ${escapeSysmlString(metadata.name)} system */

        // Entry points
${metadata.entryPoints.map((ep) => `        attribute entryPoint_${pathToIdentifier(ep)} : FilePath = "${escapeSysmlString(ep)}";`).join("\n")}

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
 */
export function generateRequirements(metadata: ProjectMetadata): string {
  return `package SystemRequirements {
    import SysMLPrimitives::*;

    doc /**System Requirements. Requirements extracted from documentation and codebase analysis for ${escapeSysmlString(metadata.name)}. */

    // Requirement definition
    requirement def DiscoveredRequirement {
        attribute id : Identifier;
        attribute source : String;
        attribute priority : String [0..1];
    }

    // Functional requirements (to be populated by analysis)
    package FunctionalRequirements {
        doc /**Functional requirements discovered from documentation */
    }

    // Non-functional requirements (to be populated by analysis)
    package NonFunctionalRequirements {
        doc /**Non-functional requirements discovered from documentation */
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

    doc /**System Architecture. Module structure and organization discovered from codebase analysis. */

    // Architecture style (to be set by analysis)
    attribute architectureStyle : String;

    // Module definition
    part def Module {
        attribute path : FilePath;
        attribute responsibility : String;
        attribute layer : String [0..1];
    }

    // Interface definition
    interface def ModuleInterface {
        attribute name : String;
        attribute methods : String [0..*];
    }

    // System decomposition (to be populated by analysis)
    part def SystemDecomposition {
        doc /**System broken down into modules */
    }

    part decomposition : SystemDecomposition;
}
`;
}

/**
 * Generate data model template (Cycle 3).
 */
export function generateDataModelTemplate(): string {
  return `package DataModel {
    import SysMLPrimitives::*;

    doc /**Data Model. Domain entities, data transfer objects, and enumerations. Data structures discovered from type definitions and schemas. */

    // Entity definitions (to be populated by analysis)
    package Entities {
        doc /**Domain entities */
    }

    // Data transfer objects (to be populated by analysis)
    package DTOs {
        doc /**Request/Response shapes */
    }

    // Events (to be populated by analysis)
    package Events {
        doc /**Domain events */
    }

    // Enumerations (to be populated by analysis)
    package Enums {
        doc /**Enumeration types */
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

    doc /**System Behavior. Operations, state machines, and event handlers. Behavioral aspects of the system. */

    // State machine template
    state def EntityLifecycle {
        doc /**Template for entity state machines */

        state Initial;
        state Processing;
        state Completed;
        state Error;
    }

    // Operation template
    action def Operation {
        doc /**Template for system operations */

        in input;
        out output;
    }

    // Operations (to be populated by analysis)
    package Operations {
        doc /**System operations discovered from handlers/controllers */
    }

    // State machines (to be populated by analysis)
    package StateMachines {
        doc /**State machines discovered from code patterns */
    }

    // Event handlers (to be populated by analysis)
    package EventHandlers {
        doc /**Event handlers discovered from code */
    }
}
`;
}

/**
 * Generate verification template (Cycle 5).
 */
export function generateVerificationTemplate(): string {
  return `package Verification {
    import SysMLPrimitives::*;
    import SystemRequirements::*;
    import SystemBehavior::*;

    doc /**Verification. Test coverage and requirement traceability. */

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

    // Test case definition
    verification def TestCase {
        attribute testFile : FilePath;
        attribute testName : String;
        attribute category : TestCategory;
    }

    // Test coverage analysis
    analysis def TestCoverage {
        results {
            attribute testedOperations : Integer;
            attribute totalOperations : Integer;
            attribute coveragePercent : Real;
        }
    }

    // Test mappings (to be populated by analysis)
    package TestMappings {
        doc /**Tests mapped to requirements and operations */
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

    doc /**Analysis. Non-functional analysis and system properties. System analysis and quality attributes. */

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

    // Analysis instances (to be populated by analysis)
    package AnalysisResults {
        doc /**Concrete analysis results */
    }
}
`;
}

/**
 * Generate the master index file.
 */
export function generateModelIndex(metadata: ProjectMetadata): string {
  return `package ${pathToIdentifier(metadata.name)}Model {
    doc /**${escapeSysmlString(metadata.name)} - SysML v2 Model. Master index file importing all model packages. Generated: ${new Date().toISOString()}. Project Type: ${metadata.projectType}. Language: ${metadata.primaryLanguage}.${metadata.framework ? ` Framework: ${metadata.framework}.` : ""} */

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
  "_stdlib.sysml": string;
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
    "_stdlib.sysml": generateStdlib(),
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
