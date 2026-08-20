import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { driver, type Driver, type DriveStep } from 'driver.js';

import '@xyflow/react/dist/style.css';
import 'driver.js/dist/driver.css';
import './styles.css';

import {
  concepts,
  edges as semanticEdges,
  implementationNodes,
  nodeById,
  routes,
  type LearningRoute,
  type SemanticEdge,
  type SemanticNode,
} from './graph.js';

interface AtlasNodeData extends Record<string, unknown> {
  semantic: SemanticNode;
  expanded: boolean;
  dimmed: boolean;
  visited: boolean;
  traced: boolean;
  handoffView: boolean;
  onExpand: (id: string) => void;
}

type AtlasNode = Node<AtlasNodeData, 'concept' | 'implementation'>;

interface AtlasEdgeData extends Record<string, unknown> {
  semantic: SemanticEdge;
  dimmed: boolean;
  traced: boolean;
  path: string;
  labelX: number;
  labelY: number;
}

type AtlasEdge = Edge<AtlasEdgeData>;

const NODE_SIZE = {
  concept: { width: 250, height: 158 },
  implementation: { width: 226, height: 132 },
} as const;

interface ElkPoint {
  x: number;
  y: number;
}

interface ElkEdgeLabel {
  id: string;
  text: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

interface ElkEdgeSection {
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}

interface ElkGraphEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels: ElkEdgeLabel[];
  sections?: ElkEdgeSection[];
}

interface ElkGraphNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkGraphNode[];
  edges?: ElkGraphEdge[];
}

const ElkConstructor = ELK as unknown as new () => {
  layout: (graph: ElkGraphNode) => Promise<ElkGraphNode>;
};
const elk = new ElkConstructor();

function estimatedEdgeLabelWidth(label: string): number {
  return Math.max(56, Math.ceil(label.length * 5.8 + 18));
}

function toneLabel(tone: SemanticNode['tone']): string {
  return {
    surface: 'surface',
    orchestration: 'orchestration',
    model: 'model role',
    capability: 'capability',
    browser: 'browser',
    store: 'run store',
    verification: 'verification',
    outcome: 'outcome',
    evaluation: 'evaluation',
    observability: 'observability',
  }[tone];
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const callableReferences = new Set([
  'ask_user',
  'bash',
  'BrowserSessionProvider.createSession',
  'browser_execute',
  'buildContextView',
  'createRunDir',
  'createWorker',
  'createWorkerToolRegistry',
  'edit_file',
  'ensureOutputContractFile',
  'executeRun',
  'finish',
  'getAccess',
  'grep',
  'publish_artifact',
  'read_file',
  'report_verification',
  'resolveRunPath',
  'resumeTask',
  'runAgent',
  'runFinishChecks',
  'runTask',
  'set_output_contract',
  'syncScratchWorkspace',
  'validateInitialContractCall',
  'write_file',
]);

const literalReferences = [
  'BrowserController',
  'BrowserSessionProvider',
  'CapResult',
  'CoordinatorState',
  'DurableRunConfiguration',
  'DurableTerminalOutcome',
  'FinishFacts',
  'FinishRequest',
  'getAccess(input)',
  'ModelDriver',
  'OutputContract.outputs',
  'OutputContract',
  'RunTaskConfig',
  'RunTaskResult',
  'RunTracing',
  'ToolDef',
  'ToolRegistry',
  'VerificationResult',
  'WORKER_API_TOOL_DEFS',
  'WORKER_TOOL_ORDER',
  'Worker',
  'WorkerState',
  'artifacts/',
  'contentExpectations',
  'contract.contentExpectations',
  'contract.outputs',
  'harness/output-contract.json',
  'harness/',
  'manifest.json',
  'metrics.json',
  'needs_correction',
  'oracleData',
  'requested_output',
  'requiresLogin',
  'runDir',
  'scratch/workspace/',
  'scratch/',
  'SHERLOCK_BROWSER_PROVIDER',
  'transcript.jsonl',
];

const codeReferences = [...callableReferences, ...literalReferences].sort(
  (left, right) => right.length - left.length,
);
const codeReferencePattern = new RegExp(
  `(?<![A-Za-z0-9_])(${codeReferences
    .map((reference) => reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?![A-Za-z0-9_])`,
  'g',
);

interface ReferencePart {
  value: string;
  code: boolean;
}

function referenceParts(value: string): ReferencePart[] {
  const parts: ReferencePart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(codeReferencePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ value: value.slice(cursor, index), code: false });
    const reference = match[0];
    parts.push({
      value: callableReferences.has(reference) ? `${reference}()` : reference,
      code: true,
    });
    cursor = index + reference.length;
  }
  if (cursor < value.length) parts.push({ value: value.slice(cursor), code: false });
  return parts;
}

function RichText({ value }: { value: string }) {
  return (
    <>
      {referenceParts(value).map((part, index) =>
        part.code ? (
          <code className="inline-code" key={`${part.value}-${index}`}>
            {part.value}
          </code>
        ) : (
          part.value
        ),
      )}
    </>
  );
}

function richMarkup(value: string): string {
  return referenceParts(value)
    .map((part) =>
      part.code
        ? `<code class="inline-code">${escapeMarkup(part.value)}</code>`
        : escapeMarkup(part.value),
    )
    .join('');
}

function richPlainText(value: string): string {
  return referenceParts(value)
    .map((part) => part.value)
    .join('');
}

function tourSection(label: string, value: string, className = ''): string {
  return `<div class="tour-section ${className}"><strong>${label}</strong><p>${richMarkup(value)}</p></div>`;
}

function SemanticCard({ data, selected }: NodeProps<AtlasNode>) {
  const node = data.semantic;
  const isConcept = node.kind === 'concept';
  return (
    <article
      id={`atlas-node-${node.id}`}
      className={[
        'semantic-card',
        `tone-${node.tone}`,
        isConcept ? 'is-concept' : 'is-implementation',
        selected ? 'is-selected' : '',
        data.expanded ? 'is-expanded' : '',
        data.dimmed ? 'is-dimmed' : '',
        data.visited ? 'is-visited' : '',
        data.traced ? 'is-traced' : '',
        data.handoffView ? 'is-handoff' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`${richPlainText(node.title)}. ${richPlainText(node.summary)}`}
    >
      <Handle className="atlas-handle" type="target" position={Position.Left} />
      <div className="card-topline">
        <span className="card-code">{node.code}</span>
        <span className="card-tone">{data.handoffView ? node.kicker : toneLabel(node.tone)}</span>
      </div>
      <h3>
        <RichText value={node.title} />
      </h3>
      <p>
        <RichText value={node.summary} />
      </p>
      <div className="card-footer">
        <span>
          {data.handoffView
            ? 'read the handoff'
            : `${node.answers.code.length} code ${node.answers.code.length === 1 ? 'site' : 'sites'}`}
        </span>
        {isConcept ? (
          <button
            className="expand-button nodrag nopan"
            type="button"
            aria-expanded={data.expanded}
            onClick={(event) => {
              event.stopPropagation();
              data.onExpand(node.id);
            }}
          >
            <span>{data.expanded ? 'Collapse' : 'Open internals'}</span>
            <span aria-hidden="true">{data.expanded ? '−' : '+'}</span>
          </button>
        ) : (
          <span className="implementation-label">implementation</span>
        )}
      </div>
      <Handle className="atlas-handle" type="source" position={Position.Right} />
    </article>
  );
}

const nodeTypes = {
  concept: SemanticCard,
  implementation: SemanticCard,
};

function SemanticEdgeView({ id, data, markerEnd, style, interactionWidth }: EdgeProps<AtlasEdge>) {
  if (data === undefined) throw new Error(`Atlas edge ${id} is missing semantic data.`);
  return (
    <>
      <BaseEdge
        id={id}
        path={data.path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactionWidth}
      />
      <EdgeLabelRenderer>
        <div
          className={[
            'atlas-edge-label',
            `edge-${data.semantic.kind}`,
            data.dimmed ? 'is-dimmed' : '',
            data.traced ? 'is-traced' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            transform: `translate(-50%, -50%) translate(${data.labelX}px, ${data.labelY}px)`,
          }}
        >
          {data.semantic.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = {
  semantic: SemanticEdgeView,
};

function implementationEdges(parentId: string): SemanticEdge[] {
  const children = implementationNodes(parentId);
  if (children.length === 0) return [];
  const result: SemanticEdge[] = [
    {
      id: `implementation-${parentId}-entry`,
      source: parentId,
      target: children[0].id,
      label: 'opens into',
      explanation: `${nodeById.get(parentId)?.title} is implemented by this local subgraph.`,
      kind: 'implementation',
    },
  ];
  for (let index = 0; index < children.length - 1; index += 1) {
    result.push({
      id: `implementation-${parentId}-${index}`,
      source: children[index].id,
      target: children[index + 1].id,
      label: 'works with',
      explanation: `Implementation detail inside ${nodeById.get(parentId)?.title}.`,
      kind: 'implementation',
    });
  }
  return result;
}

async function layoutGraph(
  visibleNodes: readonly SemanticNode[],
  visibleEdges: readonly SemanticEdge[],
  onExpand: (id: string) => void,
): Promise<{ nodes: AtlasNode[]; edges: AtlasEdge[] }> {
  const graph = await elk.layout({
    id: 'sherlock-atlas',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '44',
      'elk.layered.spacing.nodeNodeBetweenLayers': '24',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.padding': '[top=40,left=40,bottom=40,right=40]',
    },
    children: visibleNodes.map((node) => ({
      id: node.id,
      width: NODE_SIZE[node.kind].width,
      height: NODE_SIZE[node.kind].height,
    })),
    edges: visibleEdges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      labels: [
        {
          id: `${edge.id}-label`,
          text: edge.label,
          width: estimatedEdgeLabelWidth(edge.label),
          height: 18,
        },
      ],
    })),
  });

  const nodes: AtlasNode[] = (graph.children ?? []).map((laidOut) => {
    const semantic = nodeById.get(laidOut.id);
    if (semantic === undefined) throw new Error(`ELK returned unknown node ${laidOut.id}`);
    return {
      id: semantic.id,
      type: semantic.kind,
      position: { x: laidOut.x ?? 0, y: laidOut.y ?? 0 },
      width: NODE_SIZE[semantic.kind].width,
      height: NODE_SIZE[semantic.kind].height,
      selectable: true,
      draggable: false,
      data: {
        semantic,
        expanded: false,
        dimmed: false,
        visited: false,
        traced: false,
        handoffView: false,
        onExpand,
      },
    };
  });

  const laidOutEdges = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  const resultEdges: AtlasEdge[] = visibleEdges.map((semantic) => {
    const laidOut = laidOutEdges.get(semantic.id);
    const section = laidOut?.sections?.[0];
    const label = laidOut?.labels[0];
    if (
      section === undefined ||
      label === undefined ||
      label.x === undefined ||
      label.y === undefined
    ) {
      throw new Error(`ELK returned incomplete edge geometry for ${semantic.id}`);
    }
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const path = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
    return {
      id: semantic.id,
      source: semantic.source,
      target: semantic.target,
      type: 'semantic',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className: `semantic-edge edge-${semantic.kind}`,
      data: {
        semantic,
        dimmed: false,
        traced: false,
        path,
        labelX: label.x + label.width / 2,
        labelY: label.y + label.height / 2,
      },
    };
  });
  return { nodes, edges: resultEdges };
}

function proseList(values: readonly string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function Inspector({ node, onSelect }: { node: SemanticNode; onSelect: (id: string) => void }) {
  const inbound = semanticEdges.filter((edge) => edge.target === node.id);
  const outbound = semanticEdges.filter((edge) => edge.source === node.id);
  const related = [
    ...new Set([...inbound.map((edge) => edge.source), ...outbound.map((edge) => edge.target)]),
  ]
    .map((id) => nodeById.get(id))
    .filter((item): item is SemanticNode => item !== undefined);
  const upstream = [
    ...new Set(
      inbound
        .filter((edge) => edge.kind !== 'feedback')
        .map((edge) => nodeById.get(edge.source)?.title)
        .filter((title): title is string => title !== undefined),
    ),
  ];
  const downstream = [
    ...new Set(
      outbound
        .filter((edge) => edge.kind !== 'feedback')
        .map((edge) => nodeById.get(edge.target)?.title)
        .filter((title): title is string => title !== undefined),
    ),
  ];
  const flowContext =
    upstream.length > 0 && downstream.length > 0
      ? `${proseList(upstream)} brings work into this boundary. From here, the main result continues to ${proseList(downstream)}.`
      : upstream.length > 0
        ? `${proseList(upstream)} brings work into this boundary, where this branch of the system reaches its result.`
        : downstream.length > 0
          ? `This boundary begins the flow, then hands its result to ${proseList(downstream)}.`
          : 'This implementation detail is read as part of its parent concept rather than as a separate lifecycle stage.';

  return (
    <aside className="inspector" aria-label="Selected node details">
      <div className="inspector-scroll">
        <div className="inspector-heading">
          <span className={`inspector-code tone-${node.tone}`}>{node.code}</span>
          <span>{node.kicker}</span>
        </div>
        <h2>
          <RichText value={node.title} />
        </h2>
        <p className="inspector-summary">
          <RichText value={node.summary} />
        </p>
        <div className="article-flowline">
          <span>Where you are in the flow</span>
          <p>
            <RichText value={flowContext} />
          </p>
        </div>

        <article className="editorial-article">
          <p className="article-lead">
            <RichText value={node.narrative.opening} />
          </p>

          <section className="article-section">
            <h3>What happens here</h3>
            {node.narrative.mechanics.map((paragraph) => (
              <p key={paragraph}>
                <RichText value={paragraph} />
              </p>
            ))}
          </section>

          <section className="article-section article-handoff">
            <h3>How the handoff works</h3>
            <p>
              <RichText value={node.narrative.handoff} />
            </p>
          </section>

          <blockquote className="authority-pullquote">
            <span>Where its authority stops</span>
            <p>
              <RichText value={node.narrative.boundary} />
            </p>
          </blockquote>

          <section className="article-section article-why">
            <h3>Why Sherlock keeps this separate</h3>
            <p>
              <RichText value={node.answers.why} />
            </p>
          </section>

          <section className="article-section">
            <h3>Follow the implementation</h3>
            <p className="article-note">
              These are the best places to continue from the conceptual explanation into the source.
            </p>
            <div className="code-list">
              {node.answers.code.map((file) => (
                <code key={file}>{file}</code>
              ))}
            </div>
          </section>

          {related.length > 0 ? (
            <section className="article-section related-section">
              <h3>Continue through the system</h3>
              <p className="article-note">
                Follow a neighboring boundary to see what prepares this work or receives it next.
              </p>
              <div className="related-list">
                {related.map((item) => (
                  <button key={item.id} type="button" onClick={() => onSelect(item.id)}>
                    <span>{item.code}</span>
                    <RichText value={item.title} />
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </article>
      </div>
    </aside>
  );
}

function RouteMenu({
  active,
  onChange,
}: {
  active: LearningRoute;
  onChange: (route: LearningRoute) => void;
}) {
  return (
    <nav className="route-menu" aria-label="Learning paths">
      <div className="sidebar-intro" id="atlas-route-intro">
        <span className="section-kicker">Learning paths</span>
        <h2>Start small. Add depth when it earns its place.</h2>
        <p>
          Each route shows one idea. Open any concept to reveal the code-level subgraph beneath it.
        </p>
      </div>
      <div className="route-list">
        {routes.map((route) => (
          <button
            key={route.id}
            type="button"
            className={route.id === active.id ? 'route-button is-active' : 'route-button'}
            aria-current={route.id === active.id ? 'page' : undefined}
            onClick={() => onChange(route)}
          >
            <span className="route-number">{route.number}</span>
            <span className="route-copy">
              <strong>{route.title}</strong>
              <small>{route.summary}</small>
            </span>
            <span className="route-count">{route.nodeIds.length}</span>
          </button>
        ))}
      </div>
      <div className="legend">
        <span className="section-kicker">Reading the map</span>
        <div>
          <i className="legend-concept" /> Concept boundary
        </div>
        <div>
          <i className="legend-implementation" /> Implementation detail
        </div>
        <div>
          <i className="legend-feedback" /> Correction path
        </div>
      </div>
    </nav>
  );
}

function Atlas() {
  const initialRoute = routes[0];
  const [route, setRoute] = useState<LearningRoute>(initialRoute);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialRoute.nodeIds[0]);
  const [traceIndex, setTraceIndex] = useState<number | null>(null);
  const [walkthroughActive, setWalkthroughActive] = useState(false);
  const [layoutPending, setLayoutPending] = useState(true);
  const [baseNodes, setBaseNodes] = useState<AtlasNode[]>([]);
  const [baseEdges, setBaseEdges] = useState<AtlasEdge[]>([]);
  const [mobilePanel, setMobilePanel] = useState<'routes' | 'details' | null>(null);
  const tourRef = useRef<Driver | null>(null);
  const layoutRevision = useRef(0);
  const { fitView } = useReactFlow<AtlasNode, AtlasEdge>();

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    setSelectedId(id);
    setTraceIndex(null);
  }, []);

  const visibleSemanticNodes = useMemo(() => {
    const routeNodes = route.nodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is SemanticNode => node !== undefined);
    return expandedId === null ? routeNodes : [...routeNodes, ...implementationNodes(expandedId)];
  }, [expandedId, route]);

  const visibleSemanticEdges = useMemo(() => {
    const visibleIds = new Set(visibleSemanticNodes.map((node) => node.id));
    const routeEdges = semanticEdges.filter(
      (edge) =>
        visibleIds.has(edge.source) &&
        visibleIds.has(edge.target) &&
        (edge.routeIds === undefined || edge.routeIds.includes(route.id)),
    );
    return expandedId === null ? routeEdges : [...routeEdges, ...implementationEdges(expandedId)];
  }, [expandedId, route.id, visibleSemanticNodes]);

  useEffect(() => {
    const revision = layoutRevision.current + 1;
    layoutRevision.current = revision;
    setLayoutPending(true);
    void layoutGraph(visibleSemanticNodes, visibleSemanticEdges, toggleExpanded)
      .then((layout) => {
        if (layoutRevision.current !== revision) return;
        setBaseNodes(layout.nodes);
        setBaseEdges(layout.edges);
        setLayoutPending(false);
        window.requestAnimationFrame(() => {
          void fitView({ padding: 0.16, minZoom: 0.36, maxZoom: 1.05, duration: 520 });
        });
      })
      .catch((error: unknown) => {
        console.error('Unable to lay out the Sherlock atlas.', error);
        setLayoutPending(false);
      });
  }, [fitView, toggleExpanded, visibleSemanticEdges, visibleSemanticNodes]);

  useEffect(() => () => tourRef.current?.destroy(), []);

  const traceId = traceIndex === null ? null : route.nodeIds[traceIndex];
  const visitedIds = useMemo(
    () => new Set(traceIndex === null ? [] : route.nodeIds.slice(0, traceIndex)),
    [route, traceIndex],
  );

  const nodes = useMemo(
    () =>
      baseNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          expanded: expandedId === node.id,
          dimmed: traceId !== null && traceId !== node.id,
          traced: traceId === node.id,
          visited: visitedIds.has(node.id),
          handoffView: route.id === 'handoff',
        },
        className: traceId !== null && traceId !== node.id ? 'flow-node-dimmed' : '',
      })),
    [baseNodes, expandedId, route.id, traceId, visitedIds],
  );

  const edges = useMemo(
    () =>
      baseEdges.map((edge) => {
        const edgeData = edge.data;
        if (edgeData === undefined)
          throw new Error(`Atlas edge ${edge.id} is missing semantic data.`);
        const semantic = edgeData.semantic;
        const touchesTrace =
          traceId !== null && (edge.source === traceId || edge.target === traceId);
        return {
          ...edge,
          animated: touchesTrace,
          className: [
            edge.className,
            traceId !== null && !touchesTrace ? 'edge-dimmed' : '',
            touchesTrace ? 'edge-traced' : '',
          ]
            .filter(Boolean)
            .join(' '),
          data: {
            ...edgeData,
            semantic,
            dimmed: traceId !== null && !touchesTrace,
            traced: touchesTrace,
          },
        };
      }),
    [baseEdges, traceId],
  );

  const focusConcept = useCallback(
    (index: number, after?: () => void) => {
      const bounded = Math.max(0, Math.min(route.nodeIds.length - 1, index));
      const id = route.nodeIds[bounded];
      setTraceIndex(bounded);
      setSelectedId(id);
      setExpandedId(null);
      const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 430;
      window.requestAnimationFrame(() => {
        void fitView({
          nodes: [{ id }],
          padding: 2.25,
          minZoom: 0.62,
          maxZoom: 1.04,
          duration,
        }).then(() => {
          window.setTimeout(
            () => {
              tourRef.current?.refresh();
              after?.();
            },
            duration === 0 ? 0 : 80,
          );
        });
      });
    },
    [fitView, route],
  );

  const nextConcept = useCallback(() => {
    const next = traceIndex === null ? 0 : (traceIndex + 1) % route.nodeIds.length;
    focusConcept(next);
  }, [focusConcept, route, traceIndex]);

  const previousConcept = useCallback(() => {
    const previous =
      traceIndex === null
        ? route.nodeIds.length - 1
        : (traceIndex - 1 + route.nodeIds.length) % route.nodeIds.length;
    focusConcept(previous);
  }, [focusConcept, route, traceIndex]);

  const stopTrace = useCallback(() => {
    tourRef.current?.destroy();
    tourRef.current = null;
    setWalkthroughActive(false);
    setTraceIndex(null);
    void fitView({ padding: 0.16, minZoom: 0.36, maxZoom: 1.05, duration: 420 });
  }, [fitView]);

  const startWalkthrough = useCallback(() => {
    tourRef.current?.destroy();
    setWalkthroughActive(true);
    const steps: DriveStep[] = route.nodeIds.map((id, index) => {
      const node = nodeById.get(id)!;
      return {
        element: `#atlas-node-${id}`,
        data: { nodeId: id, index },
        popover: {
          title: `${node.code} · ${node.title}`,
          description: [
            `<p class="tour-lede">${richMarkup(node.narrative.opening)}</p>`,
            tourSection('What happens here', node.narrative.mechanics[0]),
            tourSection('How the handoff works', node.narrative.handoff),
            tourSection('Where its authority stops', node.narrative.boundary, 'tour-boundary'),
          ].join(''),
          side: 'bottom',
          align: 'start',
        },
      };
    });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tour = driver({
      steps,
      animate: !reducedMotion,
      duration: reducedMotion ? 0 : 260,
      allowClose: true,
      allowKeyboardControl: true,
      showProgress: true,
      progressText: '{{current}} of {{total}} concepts',
      overlayColor: '#171520',
      overlayOpacity: 0.58,
      stagePadding: 9,
      stageRadius: 10,
      popoverClass: 'sherlock-tour',
      nextBtnText: 'Next concept',
      prevBtnText: 'Back',
      doneBtnText: 'Finish route',
      onNextClick: (_element, _step, options) => {
        const current = options.driver.getActiveIndex() ?? 0;
        if (current >= steps.length - 1) {
          options.driver.destroy();
          return;
        }
        focusConcept(current + 1, () => options.driver.moveNext());
      },
      onPrevClick: (_element, _step, options) => {
        const current = options.driver.getActiveIndex() ?? 0;
        focusConcept(Math.max(0, current - 1), () => options.driver.movePrevious());
      },
      onDestroyed: () => {
        setWalkthroughActive(false);
        setTraceIndex(null);
        tourRef.current = null;
        void fitView({ padding: 0.16, minZoom: 0.36, maxZoom: 1.05, duration: 360 });
      },
    });
    tourRef.current = tour;
    focusConcept(0, () => tour.drive(0));
  }, [fitView, focusConcept, route]);

  const changeRoute = useCallback((nextRoute: LearningRoute) => {
    tourRef.current?.destroy();
    setRoute(nextRoute);
    setExpandedId(null);
    setTraceIndex(null);
    setSelectedId(nextRoute.nodeIds[0]);
    setMobilePanel(null);
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    setMobilePanel('details');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key === 'ArrowRight') nextConcept();
      if (event.key === 'ArrowLeft') previousConcept();
      if (event.key === 'Escape' && !walkthroughActive) stopTrace();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nextConcept, previousConcept, stopTrace, walkthroughActive]);

  const selectedNode = nodeById.get(selectedId) ?? nodeById.get(route.nodeIds[0])!;
  const traceNode = traceId === null ? null : (nodeById.get(traceId) ?? null);

  return (
    <main className="atlas-app">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <div>
            <span className="brand-eyebrow">Sherlock architecture</span>
            <strong>System atlas</strong>
          </div>
        </div>
        <div className="route-status">
          <span>
            {route.number} / {route.title}
          </span>
          <strong>{route.promise}</strong>
        </div>
        <div className="top-actions">
          <button
            className="mobile-menu-button"
            type="button"
            onClick={() => setMobilePanel('routes')}
          >
            Paths
          </button>
          <button
            className="tour-button"
            type="button"
            onClick={walkthroughActive ? stopTrace : startWalkthrough}
          >
            <span className="tour-icon" aria-hidden="true">
              ▶
            </span>
            {walkthroughActive ? 'End walkthrough' : 'Guide me'}
          </button>
          <button
            className="mobile-menu-button"
            type="button"
            onClick={() => setMobilePanel('details')}
          >
            Details
          </button>
        </div>
      </header>

      <div className="workspace">
        <div
          className={mobilePanel === 'routes' ? 'sidebar-shell is-mobile-open' : 'sidebar-shell'}
        >
          <button className="mobile-close" type="button" onClick={() => setMobilePanel(null)}>
            Close
          </button>
          <RouteMenu active={route} onChange={changeRoute} />
        </div>

        <section className={`canvas-shell route-${route.id}`} aria-label="Architecture graph">
          <div className="canvas-meta">
            <span>
              <strong>{route.nodeIds.length}</strong> concepts
            </span>
            <span>
              <strong>{expandedId === null ? 0 : implementationNodes(expandedId).length}</strong>{' '}
              internals open
            </span>
            <span className={layoutPending ? 'layout-state is-busy' : 'layout-state'}>
              <i />
              {layoutPending ? 'ELK arranging' : 'ELK arranged'}
            </span>
          </div>
          <div className="react-flow-wrap">
            <ReactFlow<AtlasNode, AtlasEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={(_event, node) => selectNode(node.id)}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              panOnDrag
              zoomOnScroll
              minZoom={0.28}
              maxZoom={1.5}
              proOptions={{ hideAttribution: false }}
              defaultEdgeOptions={{ interactionWidth: 18 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.25} color="#d4cfdd" />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
            {layoutPending ? (
              <div className="layout-overlay" role="status">
                Arranging semantic graph…
              </div>
            ) : null}
          </div>
          <div className="trace-deck" aria-live="polite">
            <div className="trace-copy">
              <span className="section-kicker">Concept tracer</span>
              {traceNode === null ? (
                <p>
                  Step through this route one concept at a time. Each stop tells the story of the
                  boundary and its handoff.
                </p>
              ) : (
                <div className="trace-node-copy">
                  <strong>
                    {traceNode.code} · <RichText value={traceNode.title} />
                  </strong>
                  <p>
                    <RichText value={traceNode.summary} />
                  </p>
                  <div className="trace-story">
                    <em>How it connects</em>
                    <span>
                      <RichText value={traceNode.narrative.handoff} />
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="trace-actions">
              <button type="button" onClick={previousConcept} aria-label="Previous concept">
                ←
              </button>
              <span>
                {traceIndex === null ? '—' : `${traceIndex + 1} / ${route.nodeIds.length}`}
              </span>
              <button type="button" onClick={nextConcept} aria-label="Next concept">
                →
              </button>
              {traceIndex !== null ? (
                <button className="trace-reset" type="button" onClick={stopTrace}>
                  Show route
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <div
          className={
            mobilePanel === 'details' ? 'inspector-shell is-mobile-open' : 'inspector-shell'
          }
        >
          <button className="mobile-close" type="button" onClick={() => setMobilePanel(null)}>
            Close
          </button>
          <Inspector node={selectedNode} onSelect={selectNode} />
        </div>
      </div>
      <footer className="footer">
        <span>Semantic architecture snapshot · 2026-08-20</span>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> trace · <kbd>esc</kbd> reset · scroll to zoom · drag to pan
        </span>
      </footer>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Missing #root element for Sherlock system atlas.');

createRoot(rootElement).render(
  <StrictMode>
    <ReactFlowProvider>
      <Atlas />
    </ReactFlowProvider>
  </StrictMode>,
);
