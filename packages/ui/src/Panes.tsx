import { useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { RunView, WorkspaceSnapshot } from "@ltw/domain";
import type { PreviewBlock } from "./blockMarkers";
import { Cell } from "./Cell";
import type { SourceMode } from "./Grid";
import { SOURCE_KEY } from "./layout";
import { placeView, reconcile, setRatio, type Edge, type PaneNode, type Path } from "./paneTree";
import { SourceEditor } from "./SourceEditor";
import { countCells } from "./status";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

const MIN_W = 240;
const MIN_H = 160;

interface Props {
  snap: WorkspaceSnapshot;
  text: string;
  onText: (t: string) => void;
  mode: SourceMode;
  onMode: (m: SourceMode) => void;
  runs: RunView[];
  send: Send;
  edited: boolean;
  readOnlyOld: boolean;
  title: string;
  previewBlocks: readonly PreviewBlock[] | null;
  editorKey: string;
  tree: PaneNode | null;
  onTree: (t: PaneNode) => void;
  onHide: (label: string) => void;
  linked: boolean;
}

/** Source and translations as panes that can be resized, dragged next to or above each other, and closed. */
export function Panes(props: Props) {
  const { runs, tree, onTree, linked } = props;
  const hasBlocks = (props.snap.revision?.blocks.length ?? 0) > 0;
  const views = [SOURCE_KEY, ...(hasBlocks ? runs.map((r) => r.label) : [])];
  const effective = reconcile(tree, views);
  const root = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ view: string; edge: Edge } | null>(null);

  const finishDrag = () => {
    setDragging(null);
    setDrop(null);
  };
  const place = (view: string, target: string, edge: Edge) => onTree(placeView(effective, view, target, edge));

  // Scrolling one pane brings the others to the same block.
  const onScroll = (e: React.UIEvent) => {
    const body = e.target as HTMLElement;
    if (!linked || syncing.current || !body.classList?.contains("pane-body") || !root.current) return;
    const top = body.getBoundingClientRect().top;
    let index = "";
    let frac = 0;
    for (const el of Array.from(body.querySelectorAll<HTMLElement>("[data-block]"))) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 1) {
        index = el.dataset["block"] ?? "";
        frac = (top - r.top) / Math.max(1, r.height);
        break;
      }
    }
    if (index === "") return;
    syncing.current = true;
    for (const other of Array.from(root.current.querySelectorAll<HTMLElement>(".pane-body"))) {
      if (other === body) continue;
      const el = other.querySelector<HTMLElement>(`[data-block="${index}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      other.scrollTop += r.top - other.getBoundingClientRect().top + frac * r.height;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => (syncing.current = false)));
  };

  const renderNode = (node: PaneNode, path: Path): React.ReactNode =>
    node.kind === "pane" ? (
      <Leaf key={node.view} view={node.view} {...props} only={views.length === 1} dragging={dragging} drop={drop} setDragging={setDragging} setDrop={setDrop} onPlace={place} onFinish={finishDrag} />
    ) : (
      <Split key={path} node={node} onRatio={(r) => onTree(setRatio(effective, path, r))}>
        {renderNode(node.a, `${path}a`)}
        {renderNode(node.b, `${path}b`)}
      </Split>
    );

  return (
    <div className={props.edited ? "panes dimmed" : "panes"} ref={root} onScrollCapture={onScroll}>
      {renderNode(effective, "")}
    </div>
  );
}

function Split({ node, onRatio, children }: { node: Extract<PaneNode, { kind: "split" }>; onRatio: (r: number) => void; children: React.ReactNode[] }) {
  const box = useRef<HTMLDivElement>(null);
  const row = node.axis === "row";
  const size = () => {
    const r = box.current?.getBoundingClientRect();
    return r ? (row ? r.width : r.height) : 0;
  };
  const clamp = (ratio: number) => {
    const total = size();
    const min = row ? MIN_W : MIN_H;
    return total >= min * 2 + 6 ? Math.min(1 - min / total, Math.max(min / total, ratio)) : ratio;
  };
  const start = useRef(false);
  const move = (e: ReactPointerEvent) => {
    if (!start.current || !box.current) return;
    const r = box.current.getBoundingClientRect();
    onRatio(clamp(row ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height));
  };
  const key = (e: KeyboardEvent) => {
    const back = row ? "ArrowLeft" : "ArrowUp";
    const fwd = row ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    onRatio(clamp(node.ratio + (e.shiftKey ? 0.1 : 0.02) * (e.key === back ? -1 : 1)));
  };
  const template = `minmax(0, ${node.ratio}fr) 6px minmax(0, ${1 - node.ratio}fr)`;
  return (
    <div className={`pane-split ${node.axis}`} ref={box} style={row ? { gridTemplateColumns: template } : { gridTemplateRows: template }}>
      {children[0]}
      <div
        className="pane-divider"
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = true;
        }}
        onPointerMove={move}
        onPointerUp={() => (start.current = false)}
        onPointerCancel={() => (start.current = false)}
        onDoubleClick={() => onRatio(0.5)}
        onKeyDown={key}
      />
      {children[1]}
    </div>
  );
}

/** The side of the pane the pointer is nearest to. */
function edgeAt(e: DragEvent, el: HTMLElement): Edge {
  const r = el.getBoundingClientRect();
  const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
  const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
}

function Leaf(
  p: Props & {
    view: string;
    only: boolean;
    dragging: string | null;
    drop: { view: string; edge: Edge } | null;
    setDragging: (v: string | null) => void;
    setDrop: (d: { view: string; edge: Edge } | null) => void;
    onPlace: (view: string, target: string, edge: Edge) => void;
    onFinish: () => void;
  },
) {
  const { view, snap } = p;
  const isSource = view === SOURCE_KEY;
  const run = isSource ? null : p.runs.find((r) => r.label === view) ?? null;
  const blocks = snap.revision?.blocks ?? [];
  const hasBlocks = blocks.length > 0;
  const c = run ? countCells(snap, run.id) : null;
  const dropHere = p.drop?.view === view && p.dragging !== view ? p.drop.edge : null;

  const head = (
    <header
      className="pane-head"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", view);
        p.setDragging(view);
      }}
      onDragEnd={p.onFinish}
      title="Drag to place this pane beside or above another"
    >
      <span className="gh-title">{isSource ? p.title : run?.label ?? view}</span>
      {isSource && hasBlocks && <span className="hint">{blocks.length} blocks</span>}
      {isSource && p.edited && <span className="tag warn-tag">edited</span>}
      {c && (
        <span className="hint">
          {c.done}/{c.total}
          {c.failed > 0 && ` · ${c.failed} failed`}
        </span>
      )}
      {isSource && hasBlocks && (
        <div className="segmented small" role="radiogroup" aria-label="Source view">
          <button role="radio" aria-checked={p.mode === "blocks"} className={p.mode === "blocks" ? "on" : ""} onClick={() => p.onMode("blocks")}>
            Blocks
          </button>
          <button role="radio" aria-checked={p.mode === "text"} className={p.mode === "text" ? "on" : ""} onClick={() => p.onMode("text")}>
            Edit
          </button>
        </div>
      )}
      {!isSource && (
        <button className="small head-close" draggable={false} aria-label={`Close ${view}`} title="Close this pane (bring it back from the side panel)" onClick={() => p.onHide(view)}>
          ×
        </button>
      )}
    </header>
  );

  return (
    <section
      className="pane"
      aria-label={isSource ? "Source" : view}
      onDragOver={(e) => {
        if (!p.dragging || p.dragging === view) return;
        e.preventDefault();
        const edge = edgeAt(e, e.currentTarget);
        if (p.drop?.view !== view || p.drop.edge !== edge) p.setDrop({ view, edge });
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (p.dragging && p.drop?.view === view) p.onPlace(p.dragging, view, p.drop.edge);
        p.onFinish();
      }}
    >
      {head}
      <div className="pane-body">
        {isSource ? (
          (p.mode === "text" || !hasBlocks) && !p.readOnlyOld ? (
            <SourceEditor key={p.editorKey} value={p.text} onChange={p.onText} blocks={p.previewBlocks} placeholder="Paste or type the text here, add a model, then press Run." />
          ) : (
            blocks.map((b) => (
              <div className="cell source-cell" key={b.id} data-block={b.index} id={`block-${b.index + 1}`}>
                <span className="block-no" aria-hidden="true">
                  {b.index + 1}
                </span>
                <span className="sr-only">Block {b.index + 1}. </span>
                <p className="text">{b.text}</p>
              </div>
            ))
          )
        ) : (
          run &&
          blocks.map((b) => (
            <div className="cell-slot" key={b.id} data-block={b.index}>
              <Cell
                cell={run.blocks[b.id]!}
                label={run.label}
                n={b.index + 1}
                actions={{
                  retry: () => void p.send("block.retry", { runId: run.id, blockId: b.id }),
                  cancel: () => void p.send("job.cancel", { kind: "block", runId: run.id, blockId: b.id }),
                  edit: (t) => void p.send("block.edit", { runId: run.id, blockId: b.id, text: t }),
                  acceptCandidate: () => void p.send("block.acceptCandidate", { runId: run.id, blockId: b.id }),
                  keepCurrent: () => void p.send("block.keepCurrent", { runId: run.id, blockId: b.id }),
                  acceptReview: () => void p.send("block.acceptReview", { runId: run.id, blockId: b.id }),
                }}
              />
            </div>
          ))
        )}
      </div>
      {dropHere && <div className={`drop-zone ${dropHere}`} aria-hidden="true" />}
    </section>
  );
}
