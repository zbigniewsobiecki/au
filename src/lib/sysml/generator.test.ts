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
    const content = generateModelIndex(mockMetadata);
    const result = await validateSysml(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid context/requirements.sysml", async () => {
    const content = generateRequirements(mockMetadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid context/boundaries.sysml", async () => {
    const content = generateSystemContext(mockMetadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid structure/_index.sysml", async () => {
    const content = generateStructureTemplate();
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid data/_index.sysml", async () => {
    const content = generateDataModelTemplate();
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid behavior/_index.sysml", async () => {
    const content = generateBehaviorTemplate();
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid verification/_index.sysml", async () => {
    const content = generateVerificationTemplate();
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates valid analysis/_index.sysml", async () => {
    const content = generateAnalysisTemplate();
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("generates all initial files with valid syntax", async () => {
    const files = generateInitialFiles(mockMetadata);
    const stdlib = files["SysMLPrimitives.sysml"];

    for (const [fileName, content] of Object.entries(files)) {
      // Stdlib validates on its own, others need stdlib prepended
      const result = fileName === "SysMLPrimitives.sysml"
        ? await validateSysml(content)
        : await validateSysml(stdlib + "\n\n" + content);
      expect(result.valid, `${fileName} validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
    }
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
    expect(stdlib).toContain("part def PaymentProvider");
    expect(stdlib).toContain("part def EmailProvider");
    expect(stdlib).toContain("part def StorageProvider");
  });

  it("contains service port definitions", () => {
    const stdlib = generateStdlib();
    expect(stdlib).toContain("port def HTTPPort");
    expect(stdlib).toContain("port def WebSocketPort");
    expect(stdlib).toContain("port def DatabasePort");
    expect(stdlib).toContain("port def CachePort");
    expect(stdlib).toContain("port def MessagePort");
    expect(stdlib).toContain("port def AuthPort");
    expect(stdlib).toContain("port def PaymentPort");
    expect(stdlib).toContain("port def EmailPort");
    expect(stdlib).toContain("port def StoragePort");
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
    expect(stdlib).toContain("item def AuthError");
    expect(stdlib).toContain("item def PaymentRequest");
    expect(stdlib).toContain("item def PaymentResult");
    expect(stdlib).toContain("item def EmailMessage");
    expect(stdlib).toContain("item def DeliveryResult");
    expect(stdlib).toContain("item def FileData");
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

    part paymentService : PaymentProvider {
        :>> provider = "stripe";
    }

    part emailService : EmailProvider {
        :>> provider = "sendgrid";
    }

    part fileStorage : StorageProvider {
        :>> provider = "cloudflare-r2";
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
    const content = generateSystemContext(metadata);
    const result = await validateWithStdlib(content);
    expect(result.valid, `Validation failed: ${result.issues.map((i) => i.message).join(", ")}`).toBe(true);
  });

  it("handles all ports disabled", async () => {
    const metadata: ProjectMetadata = {
      ...mockMetadata,
      ports: { http: false, grpc: false, cli: false, websocket: false, tcp: false, embedded: false },
    };
    const content = generateSystemContext(metadata);
    const result = await validateWithStdlib(content);
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
