/**
 * SysML v2 AST Node Types
 *
 * Based on the official SysML v2 metamodel and textual notation.
 */

/** Position information for source mapping */
export interface Position {
  line: number;
  column: number;
  offset?: number;
}

/** Range in source text */
export interface Range {
  start: Position;
  end: Position;
}

/** Base interface for all AST nodes */
export interface AstNode {
  $type: string;
  $range?: Range;
}

/** Identification for named elements */
export interface Identification {
  shortName?: string;
  name?: string;
}

/** Visibility kinds */
export type VisibilityKind = "public" | "private" | "protected";

/** Feature direction kinds */
export type FeatureDirectionKind = "in" | "out" | "inout";

/** Qualified name (sequence of name segments) */
export interface QualifiedName extends AstNode {
  $type: "QualifiedName";
  segments: string[];
  isGlobal?: boolean;
}

/** Comment node */
export interface Comment extends AstNode {
  $type: "Comment";
  identification?: Identification;
  locale?: string;
  body: string;
  about?: QualifiedName[];
}

/** Documentation node */
export interface Documentation extends AstNode {
  $type: "Documentation";
  identification?: Identification;
  locale?: string;
  body: string;
}

/** Textual representation */
export interface TextualRepresentation extends AstNode {
  $type: "TextualRepresentation";
  identification?: Identification;
  language: string;
  body: string;
}

/** Multiplicity bounds */
export interface MultiplicityBounds extends AstNode {
  $type: "MultiplicityBounds";
  lower?: Expression;
  upper?: Expression;
}

/** Base for all expressions */
export interface Expression extends AstNode {
  $type: string;
}

/** Literal boolean */
export interface LiteralBoolean extends Expression {
  $type: "LiteralBoolean";
  value: boolean;
}

/** Literal integer */
export interface LiteralInteger extends Expression {
  $type: "LiteralInteger";
  value: number;
}

/** Literal real */
export interface LiteralReal extends Expression {
  $type: "LiteralReal";
  value: number;
}

/** Literal string */
export interface LiteralString extends Expression {
  $type: "LiteralString";
  value: string;
}

/** Literal infinity */
export interface LiteralInfinity extends Expression {
  $type: "LiteralInfinity";
}

/** Null expression */
export interface NullExpression extends Expression {
  $type: "NullExpression";
}

/** Feature reference expression */
export interface FeatureReferenceExpression extends Expression {
  $type: "FeatureReferenceExpression";
  reference: QualifiedName;
}

/** Operator expression */
export interface OperatorExpression extends Expression {
  $type: "OperatorExpression";
  operator: string;
  operands: Expression[];
}

/** Invocation expression */
export interface InvocationExpression extends Expression {
  $type: "InvocationExpression";
  target: QualifiedName;
  arguments: Expression[];
}

/** Base for all elements */
export interface Element extends AstNode {
  identification?: Identification;
  documentation?: Documentation[];
  comments?: Comment[];
}

/** Feature value assignment */
export interface FeatureValue extends AstNode {
  $type: "FeatureValue";
  isDefault?: boolean;
  isInitial?: boolean;
  value: Expression;
}

/** Specialization (typing, subsetting, redefinition) */
export interface Specialization extends AstNode {
  $type: "Specialization";
  kind: "types" | "subsets" | "redefines" | "references" | "crosses";
  target: QualifiedName;
}

/** Feature declaration in a type body */
export interface FeatureDeclaration extends AstNode {
  $type: "FeatureDeclaration";
  direction?: FeatureDirectionKind;
  isAbstract?: boolean;
  isDerived?: boolean;
  isEnd?: boolean;
  isComposite?: boolean;
  isPortion?: boolean;
  isConstant?: boolean;
  isOrdered?: boolean;
  isUnique?: boolean;
  identification?: Identification;
  multiplicity?: MultiplicityBounds;
  specializations?: Specialization[];
  value?: FeatureValue;
}

/** Import declaration */
export interface Import extends AstNode {
  $type: "Import";
  visibility?: VisibilityKind;
  isImportAll?: boolean;
  isRecursive?: boolean;
  importedNamespace?: QualifiedName;
  importedMembership?: QualifiedName;
  filter?: Expression;
}

/** Alias member */
export interface AliasMember extends AstNode {
  $type: "AliasMember";
  visibility?: VisibilityKind;
  shortName?: string;
  name?: string;
  target: QualifiedName;
}

/** Dependency relationship */
export interface Dependency extends Element {
  $type: "Dependency";
  clients: QualifiedName[];
  suppliers: QualifiedName[];
}

/** Metadata feature */
export interface MetadataFeature extends AstNode {
  $type: "MetadataFeature";
  identification?: Identification;
  typing: QualifiedName;
  about?: QualifiedName[];
  body?: MetadataBodyElement[];
}

export interface MetadataBodyElement extends AstNode {
  $type: "MetadataBodyElement";
  name: QualifiedName;
  value?: FeatureValue;
}

/** Prefix metadata annotation */
export interface PrefixMetadataAnnotation extends AstNode {
  $type: "PrefixMetadataAnnotation";
  typing: QualifiedName;
}

// ============================================================================
// Namespace and Package
// ============================================================================

/** Package body element union type */
export type PackageBodyElement =
  | DefinitionElement
  | UsageElement
  | Import
  | AliasMember
  | Comment
  | Documentation
  | TextualRepresentation
  | MetadataFeature;

/** Root namespace (top-level document) */
export interface RootNamespace extends AstNode {
  $type: "RootNamespace";
  elements: PackageBodyElement[];
}

/** Package definition */
export interface Package extends Element {
  $type: "Package";
  isStandard?: boolean;
  isLibrary?: boolean;
  prefixMetadata?: PrefixMetadataAnnotation[];
  body: PackageBodyElement[];
}

// ============================================================================
// Definitions
// ============================================================================

/** Base definition interface */
export interface Definition extends Element {
  isAbstract?: boolean;
  prefixMetadata?: PrefixMetadataAnnotation[];
  multiplicity?: MultiplicityBounds;
  specializations?: Specialization[];
  body?: DefinitionBodyElement[];
}

export type DefinitionBodyElement =
  | DefinitionMember
  | UsageMember
  | Import
  | AliasMember
  | Comment
  | Documentation
  | TextualRepresentation
  | MetadataFeature;

export interface DefinitionMember extends AstNode {
  $type: "DefinitionMember";
  visibility?: VisibilityKind;
  element: DefinitionElement;
}

export interface UsageMember extends AstNode {
  $type: "UsageMember";
  visibility?: VisibilityKind;
  element: UsageElement;
}

/** Attribute definition */
export interface AttributeDefinition extends Definition {
  $type: "AttributeDefinition";
}

/** Enumeration definition */
export interface EnumerationDefinition extends Definition {
  $type: "EnumerationDefinition";
  variants?: EnumerationVariant[];
}

export interface EnumerationVariant extends AstNode {
  $type: "EnumerationVariant";
  identification?: Identification;
  value?: FeatureValue;
}

/** Occurrence definition */
export interface OccurrenceDefinition extends Definition {
  $type: "OccurrenceDefinition";
  isIndividual?: boolean;
}

/** Item definition */
export interface ItemDefinition extends Definition {
  $type: "ItemDefinition";
}

/** Part definition */
export interface PartDefinition extends Definition {
  $type: "PartDefinition";
}

/** Connection definition */
export interface ConnectionDefinition extends Definition {
  $type: "ConnectionDefinition";
}

/** Flow definition */
export interface FlowDefinition extends Definition {
  $type: "FlowDefinition";
}

/** Interface definition */
export interface InterfaceDefinition extends Definition {
  $type: "InterfaceDefinition";
}

/** Port definition */
export interface PortDefinition extends Definition {
  $type: "PortDefinition";
}

/** Action definition */
export interface ActionDefinition extends Definition {
  $type: "ActionDefinition";
}

/** Calculation definition */
export interface CalculationDefinition extends Definition {
  $type: "CalculationDefinition";
}

/** State definition */
export interface StateDefinition extends Definition {
  $type: "StateDefinition";
  isParallel?: boolean;
}

/** Constraint definition */
export interface ConstraintDefinition extends Definition {
  $type: "ConstraintDefinition";
}

/** Requirement definition */
export interface RequirementDefinition extends Definition {
  $type: "RequirementDefinition";
  subject?: SubjectUsage;
  actors?: ActorUsage[];
  stakeholders?: StakeholderUsage[];
  assumptions?: RequirementConstraint[];
  requirements?: RequirementConstraint[];
  framedConcerns?: ConcernUsage[];
  verifications?: RequirementUsage[];
}

export interface SubjectUsage extends AstNode {
  $type: "SubjectUsage";
  identification?: Identification;
  typing?: QualifiedName;
}

export interface ActorUsage extends AstNode {
  $type: "ActorUsage";
  identification?: Identification;
  typing?: QualifiedName;
}

export interface StakeholderUsage extends AstNode {
  $type: "StakeholderUsage";
  identification?: Identification;
  typing?: QualifiedName;
}

export interface RequirementConstraint extends AstNode {
  $type: "RequirementConstraint";
  kind: "assume" | "require";
  identification?: Identification;
  typing?: QualifiedName;
  body?: DefinitionBodyElement[];
}

/** Concern definition */
export interface ConcernDefinition extends Definition {
  $type: "ConcernDefinition";
}

/** Case definition */
export interface CaseDefinition extends Definition {
  $type: "CaseDefinition";
}

/** Analysis case definition */
export interface AnalysisCaseDefinition extends Definition {
  $type: "AnalysisCaseDefinition";
}

/** Verification case definition */
export interface VerificationCaseDefinition extends Definition {
  $type: "VerificationCaseDefinition";
}

/** Use case definition */
export interface UseCaseDefinition extends Definition {
  $type: "UseCaseDefinition";
}

/** View definition */
export interface ViewDefinition extends Definition {
  $type: "ViewDefinition";
}

/** Viewpoint definition */
export interface ViewpointDefinition extends Definition {
  $type: "ViewpointDefinition";
}

/** Rendering definition */
export interface RenderingDefinition extends Definition {
  $type: "RenderingDefinition";
}

/** Metadata definition */
export interface MetadataDefinition extends Definition {
  $type: "MetadataDefinition";
}

/** Allocation definition */
export interface AllocationDefinition extends Definition {
  $type: "AllocationDefinition";
}

/** Union type for all definition elements */
export type DefinitionElement =
  | Package
  | AttributeDefinition
  | EnumerationDefinition
  | OccurrenceDefinition
  | ItemDefinition
  | PartDefinition
  | ConnectionDefinition
  | FlowDefinition
  | InterfaceDefinition
  | PortDefinition
  | ActionDefinition
  | CalculationDefinition
  | StateDefinition
  | ConstraintDefinition
  | RequirementDefinition
  | ConcernDefinition
  | CaseDefinition
  | AnalysisCaseDefinition
  | VerificationCaseDefinition
  | UseCaseDefinition
  | ViewDefinition
  | ViewpointDefinition
  | RenderingDefinition
  | MetadataDefinition
  | AllocationDefinition
  | Dependency
  | Comment
  | Documentation
  | TextualRepresentation
  | MetadataFeature;

// ============================================================================
// Usages
// ============================================================================

/** Base usage interface */
export interface Usage extends Element {
  direction?: FeatureDirectionKind;
  isAbstract?: boolean;
  isDerived?: boolean;
  isEnd?: boolean;
  isComposite?: boolean;
  isPortion?: boolean;
  isConstant?: boolean;
  isReference?: boolean;
  isOrdered?: boolean;
  isUnique?: boolean;
  prefixMetadata?: PrefixMetadataAnnotation[];
  multiplicity?: MultiplicityBounds;
  specializations?: Specialization[];
  value?: FeatureValue;
  body?: DefinitionBodyElement[];
}

/** Attribute usage */
export interface AttributeUsage extends Usage {
  $type: "AttributeUsage";
}

/** Enumeration usage */
export interface EnumerationUsage extends Usage {
  $type: "EnumerationUsage";
}

/** Occurrence usage */
export interface OccurrenceUsage extends Usage {
  $type: "OccurrenceUsage";
  isIndividual?: boolean;
}

/** Item usage */
export interface ItemUsage extends Usage {
  $type: "ItemUsage";
}

/** Part usage */
export interface PartUsage extends Usage {
  $type: "PartUsage";
}

/** Connection usage */
export interface ConnectionUsage extends Usage {
  $type: "ConnectionUsage";
  ends?: ConnectorEnd[];
}

export interface ConnectorEnd extends AstNode {
  $type: "ConnectorEnd";
  name?: string;
  reference: QualifiedName;
  multiplicity?: MultiplicityBounds;
}

/** Flow usage */
export interface FlowUsage extends Usage {
  $type: "FlowUsage";
  from?: QualifiedName;
  to?: QualifiedName;
  payload?: PayloadFeature;
}

export interface PayloadFeature extends AstNode {
  $type: "PayloadFeature";
  identification?: Identification;
  typing?: QualifiedName;
  multiplicity?: MultiplicityBounds;
}

/** Interface usage */
export interface InterfaceUsage extends Usage {
  $type: "InterfaceUsage";
}

/** Binding usage */
export interface BindingUsage extends Usage {
  $type: "BindingUsage";
  ends?: ConnectorEnd[];
}

/** Succession usage */
export interface SuccessionUsage extends Usage {
  $type: "SuccessionUsage";
  first?: QualifiedName;
  then?: QualifiedName;
}

/** Port usage */
export interface PortUsage extends Usage {
  $type: "PortUsage";
}

/** Action usage */
export interface ActionUsage extends Usage {
  $type: "ActionUsage";
}

/** Calculation usage */
export interface CalculationUsage extends Usage {
  $type: "CalculationUsage";
  result?: Expression;
}

/** State usage */
export interface StateUsage extends Usage {
  $type: "StateUsage";
  isParallel?: boolean;
  entry?: ActionUsage;
  do?: ActionUsage;
  exit?: ActionUsage;
}

/** Transition usage */
export interface TransitionUsage extends Usage {
  $type: "TransitionUsage";
  source?: QualifiedName;
  trigger?: AcceptActionUsage;
  guard?: Expression;
  effect?: ActionUsage;
  target?: QualifiedName;
}

export interface AcceptActionUsage extends AstNode {
  $type: "AcceptActionUsage";
  payload?: QualifiedName;
}

/** Constraint usage */
export interface ConstraintUsage extends Usage {
  $type: "ConstraintUsage";
}

/** Assert constraint usage */
export interface AssertConstraintUsage extends Usage {
  $type: "AssertConstraintUsage";
  isNegated?: boolean;
}

/** Requirement usage */
export interface RequirementUsage extends Usage {
  $type: "RequirementUsage";
}

/** Satisfy requirement usage */
export interface SatisfyRequirementUsage extends Usage {
  $type: "SatisfyRequirementUsage";
  isNegated?: boolean;
  satisfiedBy?: QualifiedName;
}

/** Concern usage */
export interface ConcernUsage extends Usage {
  $type: "ConcernUsage";
}

/** Case usage */
export interface CaseUsage extends Usage {
  $type: "CaseUsage";
}

/** Analysis case usage */
export interface AnalysisCaseUsage extends Usage {
  $type: "AnalysisCaseUsage";
}

/** Verification case usage */
export interface VerificationCaseUsage extends Usage {
  $type: "VerificationCaseUsage";
}

/** Use case usage */
export interface UseCaseUsage extends Usage {
  $type: "UseCaseUsage";
}

/** Include use case usage */
export interface IncludeUseCaseUsage extends Usage {
  $type: "IncludeUseCaseUsage";
}

/** View usage */
export interface ViewUsage extends Usage {
  $type: "ViewUsage";
}

/** Viewpoint usage */
export interface ViewpointUsage extends Usage {
  $type: "ViewpointUsage";
}

/** Rendering usage */
export interface RenderingUsage extends Usage {
  $type: "RenderingUsage";
}

/** Metadata usage */
export interface MetadataUsage extends Usage {
  $type: "MetadataUsage";
}

/** Allocation usage */
export interface AllocationUsage extends Usage {
  $type: "AllocationUsage";
}

/** Reference usage (basic ref) */
export interface ReferenceUsage extends Usage {
  $type: "ReferenceUsage";
}

/** Union type for all usage elements */
export type UsageElement =
  | AttributeUsage
  | EnumerationUsage
  | OccurrenceUsage
  | ItemUsage
  | PartUsage
  | ConnectionUsage
  | FlowUsage
  | InterfaceUsage
  | BindingUsage
  | SuccessionUsage
  | PortUsage
  | ActionUsage
  | CalculationUsage
  | StateUsage
  | TransitionUsage
  | ConstraintUsage
  | AssertConstraintUsage
  | RequirementUsage
  | SatisfyRequirementUsage
  | ConcernUsage
  | CaseUsage
  | AnalysisCaseUsage
  | VerificationCaseUsage
  | UseCaseUsage
  | IncludeUseCaseUsage
  | ViewUsage
  | ViewpointUsage
  | RenderingUsage
  | MetadataUsage
  | AllocationUsage
  | ReferenceUsage;

// ============================================================================
// KerML-specific types
// ============================================================================

/** Type (KerML) */
export interface Type extends Element {
  $type: "Type";
  isAbstract?: boolean;
  isSufficient?: boolean;
  multiplicity?: MultiplicityBounds;
  specializations?: Specialization[];
  body?: TypeBodyElement[];
}

export type TypeBodyElement =
  | FeatureMember
  | Import
  | AliasMember
  | Comment
  | Documentation;

export interface FeatureMember extends AstNode {
  $type: "FeatureMember";
  visibility?: VisibilityKind;
  feature: Feature;
}

/** Feature (KerML) */
export interface Feature extends Element {
  $type: "Feature";
  direction?: FeatureDirectionKind;
  isAbstract?: boolean;
  isDerived?: boolean;
  isEnd?: boolean;
  isComposite?: boolean;
  isPortion?: boolean;
  isConstant?: boolean;
  isOrdered?: boolean;
  isUnique?: boolean;
  multiplicity?: MultiplicityBounds;
  specializations?: Specialization[];
  value?: FeatureValue;
  body?: TypeBodyElement[];
}

/** Classifier (KerML) */
export interface Classifier extends Element {
  $type: "Classifier";
  isAbstract?: boolean;
  isSufficient?: boolean;
  multiplicity?: MultiplicityBounds;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** DataType (KerML) */
export interface DataType extends Element {
  $type: "DataType";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** Class (KerML) */
export interface Class extends Element {
  $type: "Class";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** Structure (KerML) */
export interface Structure extends Element {
  $type: "Structure";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** Association (KerML) */
export interface Association extends Element {
  $type: "Association";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** Behavior (KerML) */
export interface Behavior extends Element {
  $type: "Behavior";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** Function (KerML) */
export interface Function extends Element {
  $type: "Function";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
  result?: Expression;
}

/** Predicate (KerML) */
export interface Predicate extends Element {
  $type: "Predicate";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
  result?: Expression;
}

/** Interaction (KerML) */
export interface Interaction extends Element {
  $type: "Interaction";
  isAbstract?: boolean;
  superclassifications?: QualifiedName[];
  body?: TypeBodyElement[];
}

/** Connector (KerML) */
export interface Connector extends Element {
  $type: "Connector";
  isAbstract?: boolean;
  specializations?: Specialization[];
  ends?: ConnectorEnd[];
  body?: TypeBodyElement[];
}

/** Multiplicity (KerML) */
export interface Multiplicity extends Element {
  $type: "Multiplicity";
  bounds?: MultiplicityBounds;
  subset?: QualifiedName;
}
