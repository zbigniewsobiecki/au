/**
 * SysML-to-D2 diagram extractor.
 *
 * Parses the concatenated SysML model text (=== path ===\ncontent format)
 * and extracts structured data for each diagram type. Uses regex-based
 * parsing — no AST needed since the SysML is well-structured output
 * from our own generator.
 */

export interface D2Diagram {
  type: "entity" | "state" | "flow" | "architecture";
  title: string;
  d2: string;
  sourceFiles: string[];
}

interface SysMLFile {
  path: string;
  content: string;
}

interface EntityDef {
  name: string;
  parent: string | null;
  attributes: Array<{ name: string; type: string; multiplicity: string | null }>;
  file: string;
}

interface ConnectionDef {
  name: string;
  doc: string | null;
  ends: Array<{ role: string; type: string; cardinality: string | null }>;
  file: string;
}

interface StateDef {
  name: string;
  doc: string | null;
  states: Array<{ name: string; doc: string | null }>;
  transitions: Array<{ from: string; to: string; label: string | null }>;
  file: string;
}

interface ActionDef {
  name: string;
  doc: string | null;
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
  steps: Array<{ name: string; doc: string | null }>;
  controlFlow: Array<{ from: string; to: string }>;
  file: string;
}

interface ModuleDef {
  name: string;
  parent: string | null;
  path: string | null;
  responsibility: string | null;
  layer: string | null;
  ports: Array<{ name: string; type: string; conjugated: boolean }>;
  file: string;
}

interface ModuleInstance {
  name: string;
  type: string;
  file: string;
}

interface ModuleConnection {
  name: string;
  from: string;
  to: string;
  file: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Split the concatenated SysML model into individual files */
function splitFiles(sysmlContent: string): SysMLFile[] {
  const files: SysMLFile[] = [];
  const parts = sysmlContent.split(/^=== (.+?) ===/m);
  // parts: ['', path1, content1, path2, content2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    files.push({ path: parts[i].trim(), content: parts[i + 1] || "" });
  }
  return files;
}

/** Extract content of a braced block starting at a given position */
function extractBlock(text: string, startIdx: number): string {
  let depth = 0;
  let inBlock = false;
  let blockStart = startIdx;

  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === "{") {
      if (!inBlock) {
        inBlock = true;
        blockStart = i + 1;
      }
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(blockStart, i);
      }
    }
  }
  return text.slice(blockStart);
}

/** Sanitize a name for use as a D2 identifier */
function d2Id(name: string): string {
  // D2 identifiers can be most things, but avoid dots/special chars
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Pick a color from a small palette based on index */
const STATE_COLORS = [
  "#e8f5e9", "#fff3e0", "#e3f2fd", "#fce4ec",
  "#f3e5f5", "#e0f2f1", "#fff8e1", "#fbe9e7",
  "#e8eaf6", "#f1f8e9",
];

function stateColor(index: number): string {
  return STATE_COLORS[index % STATE_COLORS.length];
}

/** Format a type string for display (strip module prefixes if long) */
function shortType(type: string): string {
  // If type has ::, take only last part for display
  const parts = type.split("::");
  return parts[parts.length - 1];
}

// ── Entity/ERD Extraction ────────────────────────────────────────────

function parseEntities(files: SysMLFile[]): EntityDef[] {
  const entities: EntityDef[] = [];
  const entityPattern = /item\s+def\s+(\w+)(?:\s*:>\s*([\w:]+))?\s*\{/g;
  const attrPattern = /attribute\s+(\w+)\s*:\s*([\w:]+)(?:\s*\[([^\]]*)\])?/g;

  for (const file of files) {
    let match: RegExpExecArray | null;
    entityPattern.lastIndex = 0;

    while ((match = entityPattern.exec(file.content)) !== null) {
      const name = match[1];
      const parent = match[2] || null;

      // Skip DTO types, API endpoints, events — only want domain entities
      if (parent && /APIEndpoint|Event$|Error$/.test(parent)) continue;

      const block = extractBlock(file.content, match.index);
      const attributes: EntityDef["attributes"] = [];

      let attrMatch: RegExpExecArray | null;
      attrPattern.lastIndex = 0;
      while ((attrMatch = attrPattern.exec(block)) !== null) {
        attributes.push({
          name: attrMatch[1],
          type: shortType(attrMatch[2]),
          multiplicity: attrMatch[3] || null,
        });
      }

      if (attributes.length > 0) {
        entities.push({ name, parent, attributes, file: file.path });
      }
    }
  }
  return entities;
}

function parseConnections(files: SysMLFile[]): ConnectionDef[] {
  const connections: ConnectionDef[] = [];
  const connPattern = /connection\s+def\s+(\w+)(?:\s*:>\s*\w+)?\s*\{/g;
  const endPattern = /end\s+(\w+)\s*:\s*(~?\w+)(?:\s*\[([^\]]*)\])?/g;
  const docPattern = /doc\s+\/\*(.+?)\*\//;

  for (const file of files) {
    let match: RegExpExecArray | null;
    connPattern.lastIndex = 0;

    while ((match = connPattern.exec(file.content)) !== null) {
      const name = match[1];
      const block = extractBlock(file.content, match.index);
      const docMatch = block.match(docPattern);
      const ends: ConnectionDef["ends"] = [];

      let endMatch: RegExpExecArray | null;
      endPattern.lastIndex = 0;
      while ((endMatch = endPattern.exec(block)) !== null) {
        ends.push({
          role: endMatch[1],
          type: endMatch[2].replace(/^~/, ""),
          cardinality: endMatch[3] || null,
        });
      }

      if (ends.length >= 2) {
        connections.push({
          name,
          doc: docMatch ? docMatch[1].trim() : null,
          ends,
          file: file.path,
        });
      }
    }
  }
  return connections;
}

function generateEntityD2(entities: EntityDef[], connections: ConnectionDef[]): string {
  const lines: string[] = [];

  // Generate sql_table shapes for each entity
  for (const entity of entities) {
    const id = d2Id(entity.name);
    lines.push(`${id}: {`);
    lines.push(`  shape: sql_table`);

    for (const attr of entity.attributes) {
      const typeLabel = attr.multiplicity
        ? `${attr.type} [${attr.multiplicity}]`
        : attr.type;

      // Mark id as primary key
      if (attr.name === "id") {
        lines.push(`  ${attr.name}: ${typeLabel} {constraint: primary_key}`);
      } else if (attr.name.endsWith("Id") || attr.name.endsWith("_id")) {
        lines.push(`  ${attr.name}: ${typeLabel} {constraint: foreign_key}`);
      } else {
        lines.push(`  ${attr.name}: ${typeLabel}`);
      }
    }
    lines.push(`}`);
    lines.push("");
  }

  // Generate connections from connection defs
  const entityNames = new Set(entities.map((e) => e.name));
  for (const conn of connections) {
    if (conn.ends.length >= 2) {
      const end1 = conn.ends[0];
      const end2 = conn.ends[1];

      // Only draw if both endpoints are in our entity set
      if (!entityNames.has(end1.type) && !entityNames.has(end2.type)) continue;

      const from = entityNames.has(end1.type) ? d2Id(end1.type) : d2Id(end1.role);
      const to = entityNames.has(end2.type) ? d2Id(end2.type) : d2Id(end2.role);

      // Build cardinality label
      const card1 = end1.cardinality || "1";
      const card2 = end2.cardinality || "1";
      const label = conn.doc || `${card1} to ${card2}`;

      lines.push(`${from} <-> ${to}: "${label}"`);
    }
  }

  return lines.join("\n");
}

export function extractEntityDiagrams(sysmlContent: string): D2Diagram[] {
  const files = splitFiles(sysmlContent);
  const entities = parseEntities(files);
  const connections = parseConnections(files);

  if (entities.length === 0) return [];

  // Group entities by their parent type (BaseEntity vs others)
  const domainEntities = entities.filter(
    (e) => e.parent && /BaseEntity|Entity/.test(e.parent)
  );
  const dtoEntities = entities.filter(
    (e) => e.parent && /BaseDTO|DTO|Request|Response/.test(e.parent)
  );
  const otherEntities = entities.filter(
    (e) => !domainEntities.includes(e) && !dtoEntities.includes(e)
  );

  const diagrams: D2Diagram[] = [];

  // Domain entity diagram (the main ERD)
  const erd = domainEntities.length > 0 ? domainEntities : otherEntities;
  if (erd.length > 0) {
    const d2 = generateEntityD2(erd, connections);
    if (d2.trim()) {
      diagrams.push({
        type: "entity",
        title: "Domain Entity Relationships",
        d2,
        sourceFiles: [...new Set(erd.map((e) => e.file))],
      });
    }
  }

  // DTO diagram (if distinct from domain entities)
  if (dtoEntities.length >= 2) {
    const d2 = generateEntityD2(dtoEntities, []);
    if (d2.trim()) {
      diagrams.push({
        type: "entity",
        title: "Data Transfer Objects",
        d2,
        sourceFiles: [...new Set(dtoEntities.map((e) => e.file))],
      });
    }
  }

  return diagrams;
}

// ── State Machine Extraction ─────────────────────────────────────────

function parseStateDefs(files: SysMLFile[]): StateDef[] {
  const stateDefs: StateDef[] = [];
  const stateDefPattern = /state\s+def\s+(\w+)\s*\{/g;
  const statePattern = /state\s+(\w+)\s*(?:\{|;)/g;
  const transitionPattern =
    /transition(?:\s+(\w+))?\s+first\s+(\w+)\s+then\s+(\w+)\s*;/g;
  const docPattern = /doc\s+\/\*(.+?)\*\//;

  for (const file of files) {
    let match: RegExpExecArray | null;
    stateDefPattern.lastIndex = 0;

    while ((match = stateDefPattern.exec(file.content)) !== null) {
      const name = match[1];
      const block = extractBlock(file.content, match.index);
      const docMatch = block.match(docPattern);

      const states: StateDef["states"] = [];
      const transitions: StateDef["transitions"] = [];

      // Extract states
      let stateMatch: RegExpExecArray | null;
      statePattern.lastIndex = 0;
      while ((stateMatch = statePattern.exec(block)) !== null) {
        const stateName = stateMatch[1];
        // Skip the 'def' keyword match
        if (stateName === "def") continue;
        // Extract doc comment for this state if available
        const stateBlock =
          stateMatch[0].endsWith("{")
            ? extractBlock(block, stateMatch.index)
            : "";
        const stateDoc = stateBlock.match(docPattern);
        states.push({ name: stateName, doc: stateDoc ? stateDoc[1].trim() : null });
      }

      // Extract transitions
      let transMatch: RegExpExecArray | null;
      transitionPattern.lastIndex = 0;
      while ((transMatch = transitionPattern.exec(block)) !== null) {
        transitions.push({
          from: transMatch[2],
          to: transMatch[3],
          label: transMatch[1] || null,
        });
      }

      if (states.length > 0 || transitions.length > 0) {
        stateDefs.push({
          name,
          doc: docMatch ? docMatch[1].trim() : null,
          states,
          transitions,
          file: file.path,
        });
      }
    }
  }
  return stateDefs;
}

export function extractStateDiagrams(sysmlContent: string): D2Diagram[] {
  const files = splitFiles(sysmlContent);
  const stateDefs = parseStateDefs(files);

  return stateDefs.map((sd) => {
    const lines: string[] = ["direction: right", ""];

    // Declare states with colors
    sd.states.forEach((s, i) => {
      lines.push(`${d2Id(s.name)}: ${s.name} {style.fill: "${stateColor(i)}"}`);
    });

    // If we have transitions but some states aren't declared, add them
    const declaredStates = new Set(sd.states.map((s) => s.name));
    for (const t of sd.transitions) {
      if (!declaredStates.has(t.from)) {
        lines.push(`${d2Id(t.from)}: ${t.from} {style.fill: "${stateColor(declaredStates.size)}"}`);
        declaredStates.add(t.from);
      }
      if (!declaredStates.has(t.to)) {
        lines.push(`${d2Id(t.to)}: ${t.to} {style.fill: "${stateColor(declaredStates.size)}"}`);
        declaredStates.add(t.to);
      }
    }

    lines.push("");

    // Transitions
    for (const t of sd.transitions) {
      const label = t.label ? `: ${t.label}` : "";
      lines.push(`${d2Id(t.from)} -> ${d2Id(t.to)}${label}`);
    }

    return {
      type: "state" as const,
      title: `${sd.name} State Machine`,
      d2: lines.join("\n"),
      sourceFiles: [sd.file],
    };
  });
}

// ── Action Flow Extraction ───────────────────────────────────────────

function parseActionDefs(files: SysMLFile[]): ActionDef[] {
  const actionDefs: ActionDef[] = [];
  // Match top-level action def (not nested action steps)
  const actionDefPattern = /^\s*action\s+def\s+(\w+)\s*\{/gm;
  const inParamPattern = /^\s*in\s+(\w+)\s*:\s*([\w:]+)/gm;
  const outParamPattern = /^\s*out\s+(\w+)\s*:\s*([\w:]+)/gm;
  // Nested action steps (not action def)
  const actionStepPattern = /^\s*action\s+(\w+)\s*(?:\{|;)/gm;
  const firstThenPattern = /first\s+(\w+)\s+then\s+(\w+)\s*;/g;
  const docPattern = /doc\s+\/\*(.+?)\*\//;

  for (const file of files) {
    let match: RegExpExecArray | null;
    actionDefPattern.lastIndex = 0;

    while ((match = actionDefPattern.exec(file.content)) !== null) {
      const name = match[1];
      const block = extractBlock(file.content, match.index);

      // Skip if this action has no control flow (just event handlers etc.)
      if (!block.includes("first ") || !block.includes(" then ")) continue;

      const docMatch = block.match(docPattern);

      const inputs: ActionDef["inputs"] = [];
      const outputs: ActionDef["outputs"] = [];
      const steps: ActionDef["steps"] = [];
      const controlFlow: ActionDef["controlFlow"] = [];

      // Parse inputs
      let paramMatch: RegExpExecArray | null;
      inParamPattern.lastIndex = 0;
      while ((paramMatch = inParamPattern.exec(block)) !== null) {
        inputs.push({ name: paramMatch[1], type: shortType(paramMatch[2]) });
      }

      // Parse outputs
      outParamPattern.lastIndex = 0;
      while ((paramMatch = outParamPattern.exec(block)) !== null) {
        outputs.push({ name: paramMatch[1], type: shortType(paramMatch[2]) });
      }

      // Parse action steps (filter to only first-level nested actions)
      actionStepPattern.lastIndex = 0;
      let stepMatch: RegExpExecArray | null;
      while ((stepMatch = actionStepPattern.exec(block)) !== null) {
        const stepName = stepMatch[1];
        if (stepName === "def") continue;
        const stepBlock =
          stepMatch[0].trimStart().endsWith("{")
            ? extractBlock(block, stepMatch.index)
            : "";
        const stepDoc = stepBlock.match(docPattern);
        steps.push({
          name: stepName,
          doc: stepDoc ? stepDoc[1].trim() : null,
        });
      }

      // Parse control flow
      firstThenPattern.lastIndex = 0;
      let flowMatch: RegExpExecArray | null;
      while ((flowMatch = firstThenPattern.exec(block)) !== null) {
        controlFlow.push({ from: flowMatch[1], to: flowMatch[2] });
      }

      if (steps.length > 0 && controlFlow.length > 0) {
        actionDefs.push({
          name,
          doc: docMatch ? docMatch[1].trim() : null,
          inputs,
          outputs,
          steps,
          controlFlow,
          file: file.path,
        });
      }
    }
  }
  return actionDefs;
}

function camelToTitle(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

export function extractFlowDiagrams(sysmlContent: string): D2Diagram[] {
  const files = splitFiles(sysmlContent);
  const actionDefs = parseActionDefs(files);

  return actionDefs.map((ad) => {
    const lines: string[] = ["direction: down", ""];

    // Add input parameters as parallelogram shapes
    for (const inp of ad.inputs) {
      lines.push(`${d2Id(inp.name)}: {shape: parallelogram; "${inp.type}"}`);
    }

    // Add action steps
    for (const step of ad.steps) {
      const label = step.doc || camelToTitle(step.name);
      lines.push(`${d2Id(step.name)}: "${label}"`);
    }

    // Add output parameters as parallelogram shapes
    for (const out of ad.outputs) {
      lines.push(`${d2Id(out.name)}: {shape: parallelogram; "${out.type}"}`);
    }

    lines.push("");

    // Find the first step (one that appears as 'from' but not derived from input)
    const fromSteps = new Set(ad.controlFlow.map((cf) => cf.from));
    const toSteps = new Set(ad.controlFlow.map((cf) => cf.to));
    const firstStep = ad.controlFlow.length > 0 ? ad.controlFlow[0].from : null;
    const lastStep = ad.controlFlow.length > 0
      ? ad.controlFlow[ad.controlFlow.length - 1].to
      : null;

    // Connect inputs to first step
    if (firstStep && ad.inputs.length > 0) {
      for (const inp of ad.inputs) {
        lines.push(`${d2Id(inp.name)} -> ${d2Id(firstStep)}`);
      }
    }

    // Connect action steps
    for (const cf of ad.controlFlow) {
      lines.push(`${d2Id(cf.from)} -> ${d2Id(cf.to)}`);
    }

    // Connect last step to outputs
    if (lastStep) {
      for (const out of ad.outputs) {
        if (out.name !== "error") {
          lines.push(`${d2Id(lastStep)} -> ${d2Id(out.name)}`);
        }
      }
    }

    return {
      type: "flow" as const,
      title: `${camelToTitle(ad.name)} Flow`,
      d2: lines.join("\n"),
      sourceFiles: [ad.file],
    };
  });
}

// ── Architecture Extraction ──────────────────────────────────────────

function parseModules(files: SysMLFile[]): ModuleDef[] {
  const modules: ModuleDef[] = [];
  const modulePattern = /part\s+def\s+(\w+)\s*:>\s*([\w:]+)\s*\{/g;
  const pathPattern = /:>>\s*path\s*=\s*"([^"]+)"/;
  const respPattern = /:>>\s*responsibility\s*=\s*"([^"]+)"/;
  const layerPattern = /:>>\s*layer\s*=\s*"([^"]+)"/;
  const portPattern = /port\s+(\w+)\s*:\s*(~?)(\w+)/g;

  for (const file of files) {
    let match: RegExpExecArray | null;
    modulePattern.lastIndex = 0;

    while ((match = modulePattern.exec(file.content)) !== null) {
      const name = match[1];
      const parent = match[2];
      const block = extractBlock(file.content, match.index);

      const pathMatch = block.match(pathPattern);
      const respMatch = block.match(respPattern);
      const layerMatch = block.match(layerPattern);

      const ports: ModuleDef["ports"] = [];
      let portMatch: RegExpExecArray | null;
      portPattern.lastIndex = 0;
      while ((portMatch = portPattern.exec(block)) !== null) {
        ports.push({
          name: portMatch[1],
          type: portMatch[3],
          conjugated: portMatch[2] === "~",
        });
      }

      modules.push({
        name,
        parent,
        path: pathMatch ? pathMatch[1] : null,
        responsibility: respMatch ? respMatch[1] : null,
        layer: layerMatch ? layerMatch[1] : null,
        ports,
        file: file.path,
      });
    }
  }
  return modules;
}

function parseModuleInstances(files: SysMLFile[]): ModuleInstance[] {
  const instances: ModuleInstance[] = [];
  // Match 'part name : Type;' but not 'part def'
  const instancePattern = /^\s*part\s+(\w+)\s*:\s*(\w+)\s*;/gm;

  for (const file of files) {
    let match: RegExpExecArray | null;
    instancePattern.lastIndex = 0;

    while ((match = instancePattern.exec(file.content)) !== null) {
      instances.push({ name: match[1], type: match[2], file: file.path });
    }
  }
  return instances;
}

function parseModuleConnections(files: SysMLFile[]): ModuleConnection[] {
  const conns: ModuleConnection[] = [];
  const connPattern = /connection\s+(\w+)\s+connect\s+([\w.]+)\s+to\s+([\w.]+)\s*;/g;

  for (const file of files) {
    let match: RegExpExecArray | null;
    connPattern.lastIndex = 0;

    while ((match = connPattern.exec(file.content)) !== null) {
      conns.push({
        name: match[1],
        from: match[2],
        to: match[3],
        file: file.path,
      });
    }
  }
  return conns;
}

export function extractArchitectureDiagram(
  sysmlContent: string,
): D2Diagram | null {
  const files = splitFiles(sysmlContent);
  const modules = parseModules(files);
  const instances = parseModuleInstances(files);
  const connections = parseModuleConnections(files);

  if (modules.length < 2) return null;

  const lines: string[] = ["direction: down", ""];

  // Group modules by layer for visual organization
  const layerGroups = new Map<string, ModuleDef[]>();
  const noLayer: ModuleDef[] = [];

  for (const mod of modules) {
    const layer = mod.layer || null;
    if (layer) {
      if (!layerGroups.has(layer)) layerGroups.set(layer, []);
      layerGroups.get(layer)!.push(mod);
    } else {
      noLayer.push(mod);
    }
  }

  // Build a lookup from module type name to its definition
  const moduleByName = new Map(modules.map((m) => [m.name, m]));

  // Render modules grouped by layer
  if (layerGroups.size > 0) {
    for (const [layer, mods] of layerGroups) {
      const layerLabel = layer.charAt(0).toUpperCase() + layer.slice(1);
      lines.push(`${d2Id(layerLabel)}: ${layerLabel} {`);

      for (const mod of mods) {
        const label = mod.responsibility || mod.name;
        lines.push(`  ${d2Id(mod.name)}: "${label}"`);
      }

      lines.push(`}`);
      lines.push("");
    }
  }

  // Ungrouped modules
  if (noLayer.length > 0 && layerGroups.size > 0) {
    lines.push(`Infrastructure: {`);
    for (const mod of noLayer) {
      const label = mod.responsibility || mod.name;
      lines.push(`  ${d2Id(mod.name)}: "${label}"`);
    }
    lines.push(`}`);
    lines.push("");
  } else if (noLayer.length > 0) {
    // No layers at all — just list modules flat
    for (const mod of noLayer) {
      const label = mod.responsibility || mod.name;
      lines.push(`${d2Id(mod.name)}: "${label}"`);
    }
    lines.push("");
  }

  // Render connections
  for (const conn of connections) {
    // Parse dot-paths: instanceName.portName
    const fromParts = conn.from.split(".");
    const toParts = conn.to.split(".");

    // Resolve instance to module type
    const fromInstance = instances.find((i) => i.name === fromParts[0]);
    const toInstance = instances.find((i) => i.name === toParts[0]);

    const fromModule = fromInstance ? moduleByName.get(fromInstance.type) : null;
    const toModule = toInstance ? moduleByName.get(toInstance.type) : null;

    if (fromModule && toModule) {
      // Build qualified D2 path if inside a layer group
      const fromLayer = fromModule.layer
        ? `${d2Id(fromModule.layer.charAt(0).toUpperCase() + fromModule.layer.slice(1))}.`
        : "";
      const toLayer = toModule.layer
        ? `${d2Id(toModule.layer.charAt(0).toUpperCase() + toModule.layer.slice(1))}.`
        : "";

      const fromId = `${fromLayer}${d2Id(fromModule.name)}`;
      const toId = `${toLayer}${d2Id(toModule.name)}`;
      const label = conn.name.replace(/([A-Z])/g, " $1").trim();

      lines.push(`${fromId} -> ${toId}: "${label}"`);
    }
  }

  const sourceFiles = [
    ...new Set([
      ...modules.map((m) => m.file),
      ...connections.map((c) => c.file),
    ]),
  ];

  const d2 = lines.join("\n");

  // Only return if we generated meaningful content
  if (modules.length < 2) return null;

  return {
    type: "architecture",
    title: "System Architecture",
    d2,
    sourceFiles,
  };
}

// ── Main Entry Point ─────────────────────────────────────────────────

export function extractDiagrams(sysmlContent: string): D2Diagram[] {
  const diagrams: D2Diagram[] = [];

  const entities = extractEntityDiagrams(sysmlContent);
  diagrams.push(...entities);

  const states = extractStateDiagrams(sysmlContent);
  diagrams.push(...states);

  const flows = extractFlowDiagrams(sysmlContent);
  diagrams.push(...flows);

  const arch = extractArchitectureDiagram(sysmlContent);
  if (arch) diagrams.push(arch);

  return diagrams;
}
