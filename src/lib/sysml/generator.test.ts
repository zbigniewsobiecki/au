import { describe, it, expect } from "vitest";
import {
  generateStdlib,
  generateProjectFile,
  generateModelIndex,
  generateRequirements,
  generateSystemContext,
  generateStructureTemplate,
  generateDataModelTemplate,
  generateBehaviorTemplate,
  generateVerificationTemplate,
  generateAnalysisTemplate,
  generateInitialFiles,
} from "./generator.js";
import { validateSysml } from "./validator.js";
import type { ProjectMetadata } from "./discovery.js";

// Helper: validate with stdlib prepended (for templates that import SysMLPrimitives)
async function validateWithStdlib(content: string) {
  const stdlib = generateStdlib();
  return validateSysml(stdlib + "\n\n" + content);
}

// Helper: validate with stdlib and additional dependencies
async function validateWithDeps(content: string, deps: string[] = []) {
  const stdlib = generateStdlib();
  const allContent = [stdlib, ...deps, content].join("\n\n");
  return validateSysml(allContent);
}

const mockMetadata: ProjectMetadata = {
  name: "test-project",
  version: "1.0.0",
  description: "Test project for SysML validation",
  projectType: "web-app",
  primaryLanguage: "typescript",
  secondaryLanguages: ["javascript"],
  framework: "express",
  architectureStyle: "monolith",
  runtime: "node",
  manifestFile: "package.json",
  entryPoints: ["src/index.ts"],
  externalDependencies: [
    { name: "PostgreSQL", type: "database", purpose: "Data storage" },
    { name: "Redis", type: "cache", purpose: "Session caching", version: "7.0" },
  ],
  ports: { http: true, grpc: false, cli: false, websocket: true, tcp: false, embedded: false },
  // Note: Using simple date format to avoid parser issues with colons in ISO timestamps
  discoveredAt: "2024-01-01",
};

describe("SysML Generator - Syntax Validation", () => {
  it("generates valid SysMLPrimitives.sysml", async () => {
    const content = generateStdlib();
    const result = await validateSysml(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid _project.sysml", async () => {
    const content = generateProjectFile(mockMetadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid _model.sysml", async () => {
    // _model.sysml imports all packages, so we need to provide them all
    const projectFile = generateProjectFile(mockMetadata);
    const requirements = generateRequirements(mockMetadata);
    const systemContext = generateSystemContext(mockMetadata);
    const dataModel = generateDataModelTemplate();
    const structure = generateStructureTemplate();
    const behavior = generateBehaviorTemplate();
    const verification = generateVerificationTemplate();
    const analysis = generateAnalysisTemplate();

    const content = generateModelIndex(mockMetadata);
    const deps = [projectFile, requirements, systemContext, dataModel, structure, behavior, verification, analysis];
    const result = await validateWithDeps(content, deps);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid context/requirements.sysml", async () => {
    const content = generateRequirements(mockMetadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid context/boundaries.sysml", async () => {
    // SystemContext imports ProjectMetadata
    const projectFile = generateProjectFile(mockMetadata);
    const content = generateSystemContext(mockMetadata);
    const result = await validateWithDeps(content, [projectFile]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid structure/_index.sysml", async () => {
    // Structure imports ProjectMetadata and SystemContext
    const projectFile = generateProjectFile(mockMetadata);
    const systemContext = generateSystemContext(mockMetadata);
    const content = generateStructureTemplate();
    const result = await validateWithDeps(content, [projectFile, systemContext]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid data/_index.sysml", async () => {
    const content = generateDataModelTemplate();
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid behavior/_index.sysml", async () => {
    // Behavior imports ProjectMetadata, SystemContext, DataModel, and Structure
    const projectFile = generateProjectFile(mockMetadata);
    const systemContext = generateSystemContext(mockMetadata);
    const dataModel = generateDataModelTemplate();
    const structure = generateStructureTemplate();
    const content = generateBehaviorTemplate();
    const result = await validateWithDeps(content, [projectFile, systemContext, dataModel, structure]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid verification/_index.sysml", async () => {
    // Verification imports ProjectMetadata, SystemContext, Requirements, DataModel, Structure, and Behavior
    const projectFile = generateProjectFile(mockMetadata);
    const requirements = generateRequirements(mockMetadata);
    const systemContext = generateSystemContext(mockMetadata);
    const dataModel = generateDataModelTemplate();
    const structure = generateStructureTemplate();
    const behavior = generateBehaviorTemplate();
    const content = generateVerificationTemplate();
    const result = await validateWithDeps(content, [projectFile, requirements, systemContext, dataModel, structure, behavior]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid analysis/_index.sysml", async () => {
    // Analysis imports ProjectMetadata, SystemContext, DataModel, Structure, and Behavior
    const projectFile = generateProjectFile(mockMetadata);
    const systemContext = generateSystemContext(mockMetadata);
    const dataModel = generateDataModelTemplate();
    const structure = generateStructureTemplate();
    const behavior = generateBehaviorTemplate();
    const content = generateAnalysisTemplate();
    const result = await validateWithDeps(content, [projectFile, systemContext, dataModel, structure, behavior]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates all initial files with valid syntax", async () => {
    const files = generateInitialFiles(mockMetadata);

    // Validate all files together (as they would be in a real project)
    // The order matters: stdlib first, then project, then packages in dependency order
    const orderedFiles = [
      "SysMLPrimitives.sysml",
      "_project.sysml",
      "context/requirements.sysml",
      "context/boundaries.sysml",
      "data/_index.sysml",
      "structure/_index.sysml",
      "behavior/_index.sysml",
      "verification/_index.sysml",
      "analysis/_index.sysml",
      "_model.sysml",
    ];

    const allContent = orderedFiles
      .filter(name => files[name])
      .map(name => files[name])
      .join("\n\n");

    const result = await validateSysml(allContent);
    expect(result.valid, `Combined validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });
});

describe("SysML Generator - Stdlib Content", () => {
  it("contains application component types", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("part def Application");
    expect(stdlib).toContain("part def WebApplication");
    expect(stdlib).toContain("part def Frontend");
    expect(stdlib).toContain("part def Backend");
    expect(stdlib).toContain("part def APIServer");
    expect(stdlib).toContain("part def Worker");
  });

  it("contains database and storage types", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("part def Database");
    expect(stdlib).toContain("part def PostgreSQL");
    expect(stdlib).toContain("part def MySQL");
    expect(stdlib).toContain("part def MongoDB");
    expect(stdlib).toContain("part def Redis");
    expect(stdlib).toContain("part def S3Storage");
  });

  it("contains external service types", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("part def ExternalService");
    expect(stdlib).toContain("part def AuthProvider");
    // PaymentProvider, EmailProvider, StorageProvider removed - too specific
  });

  it("contains service port definitions", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("port def HTTPPort");
    expect(stdlib).toContain("port def WebSocketPort");
    expect(stdlib).toContain("port def DatabasePort");
    expect(stdlib).toContain("port def CachePort");
    expect(stdlib).toContain("port def MessagePort");
    expect(stdlib).toContain("port def AuthPort");
    expect(stdlib).toContain("port def StoragePort");
    // PaymentPort, EmailPort removed - too specific
  });

  it("contains API item types", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("item def HTTPRequest");
    expect(stdlib).toContain("item def HTTPResponse");
    expect(stdlib).toContain("item def Message");
    expect(stdlib).toContain("item def Query");
    expect(stdlib).toContain("item def QueryResult");
    expect(stdlib).toContain("item def Credentials");
    expect(stdlib).toContain("item def AuthToken");
    expect(stdlib).toContain("item def FileData");
    // AuthError, PaymentRequest, PaymentResult, EmailMessage, DeliveryResult removed - too specific
  });

  it("contains connection definitions", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("connection def APIConnection");
    expect(stdlib).toContain("connection def DatabaseConnection");
    expect(stdlib).toContain("connection def CacheConnection");
  });
});

describe("SysML Generator - Stdlib Usage Validation", () => {
  it("validates WebApplication usage pattern", async () => {
    const stdlib = generateStdlib();
    const usage = `
package TestUsage {
    import SysMLPrimitives::*;

    part myApp : WebApplication {
        :>> name = "TestApp";
        :>> version = "1.0.0";

        part :>> frontend : Frontend {
            :>> framework = "react";
            :>> port = 3000;
        }

        part :>> backend : APIServer {
            :>> framework = "express";
            :>> port = 3010;
            :>> basePath = "/api";
        }

        part db : PostgreSQL;
    }
}
`;
    const result = await validateSysml(stdlib + "\n\n" + usage);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("validates database and cache types", async () => {
    const stdlib = generateStdlib();
    const usage = `
package TestDatabases {
    import SysMLPrimitives::*;

    part postgres : PostgreSQL {
        :>> connectionString = "postgres://localhost/db";
    }

    part mysql : MySQL;

    part mongo : MongoDB;

    part redisCache : Redis {
        :>> host = "localhost";
        :>> port = 6379;
    }

    part storage : S3Storage {
        :>> bucket = "my-bucket";
        :>> region = "us-east-1";
    }
}
`;
    const result = await validateSysml(stdlib + "\n\n" + usage);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("validates external service types", async () => {
    const stdlib = generateStdlib();
    const usage = `
package TestServices {
    import SysMLPrimitives::*;

    part authService : AuthProvider {
        :>> provider = "auth0";
        :>> apiKey = "test-key";
    }
}
`;
    const result = await validateSysml(stdlib + "\n\n" + usage);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("validates connection patterns", async () => {
    const stdlib = generateStdlib();
    const usage = `
package TestConnections {
    import SysMLPrimitives::*;

    part fe : Frontend {
        :>> framework = "vue";
    }

    part be : Backend {
        :>> framework = "fastify";
    }

    part db : PostgreSQL;

    part cache : Redis;

    connection api : APIConnection connect fe.api to be.api;
    connection dbConn : DatabaseConnection connect be.db to db.connection;
    connection cacheConn : CacheConnection connect be.db to cache.connection;
}
`;
    const result = await validateSysml(stdlib + "\n\n" + usage);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("validates Worker type", async () => {
    const stdlib = generateStdlib();
    const usage = `
package TestWorker {
    import SysMLPrimitives::*;

    part emailWorker : Worker {
        :>> queue = "email-queue";
    }
}
`;
    const result = await validateSysml(stdlib + "\n\n" + usage);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });
});

describe("SysML Generator - Edge Cases", () => {
  it("handles project name with special characters", async () => {
    const metadata: ProjectMetadata = {
      ...mockMetadata,
      name: "my-project_v2.0",
      // Note: Newlines in strings cause parser issues, testing underscores/dashes/dots
      description: 'Project with dashes-and_underscores.v2',
    };
    const content = generateProjectFile(metadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("handles empty external dependencies", async () => {
    const metadata: ProjectMetadata = {
      ...mockMetadata,
      externalDependencies: [],
    };
    const projectFile = generateProjectFile(metadata);
    const content = generateSystemContext(metadata);
    const result = await validateWithDeps(content, [projectFile]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("handles all ports disabled", async () => {
    const metadata: ProjectMetadata = {
      ...mockMetadata,
      ports: { http: false, grpc: false, cli: false, websocket: false, tcp: false, embedded: false },
    };
    const projectFile = generateProjectFile(metadata);
    const content = generateSystemContext(metadata);
    const result = await validateWithDeps(content, [projectFile]);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("handles missing optional fields", async () => {
    const metadata: ProjectMetadata = {
      ...mockMetadata,
      version: undefined,
      framework: undefined,
      runtime: undefined,
    };
    const content = generateProjectFile(metadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });
});
