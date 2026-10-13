import { useEffect, useRef, useState } from "react";
import type { ExportFormat, ExportInput, ExportPreview, ExportTextVersion, WorkspaceSnapshot } from "@ltw/domain";
import { api } from "./api";
import { countCells } from "./status";

const FORMATS: { id: ExportFormat; title: string; help: string }[] = [
  { id: "text", title: "Plain text", help: "One model" },
  { id: "markdown", title: "Markdown", help: "One or several models" },
  { id: "csv", title: "Spreadsheet (CSV)", help: "Side by side; opens in Excel" },
];

/** Choose what to export, see exactly what will be in the file, and save it. Exporting never starts a translation. */
export function ExportDialog({ snap, onClose }: { snap: WorkspaceSnapshot; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<ExportFormat>(snap.runs.length === 1 ? "text" : "csv");
  const [runIds, setRunIds] = useState<string[]>(snap.runs.map((r) => r.id));
  const [textVersion, setTextVersion] = useState<ExportTextVersion>("current");
  const [allowPartial, setAllowPartial] = useState(false);
  const [formulaSafe, setFormulaSafe] = useState(true);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Text holds one model only.
  const chosen = format === "text" ? runIds.slice(0, 1) : runIds;
  const input: ExportInput = { format, runIds: chosen, textVersion, allowPartial, formulaSafe };
  const key = JSON.stringify(input);
  // Recompute when results change (counts) or choices change.
  const progress = JSON.stringify(countCells(snap));

  useEffect(() => {
    let live = true;
    void api.invoke("export.preview", JSON.parse(key) as ExportInput).then((r) => {
      if (!live) return;
      if (r.ok) {
        setPreview(r.value);
        setError(null);
      } else setError(r.error.message);
    });
    return () => {
      live = false;
    };
  }, [key, progress]);

  const toggleRun = (id: string) => {
    if (format === "text") setRunIds([id]);
    else setRunIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : snap.runs.map((r) => r.id).filter((x) => x === id || cur.includes(x))));
  };

  const needsPartial = preview !== null && !preview.complete;
  const canExport = preview !== null && preview.problem === null && (!needsPartial || allowPartial) && !busy;

  const write = async () => {
    setBusy(true);
    setSaved(null);
    const r = await api.invoke("export.write", input);
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    else if (r.value.path) {
      setError(null);
      setSaved(`Saved to ${r.value.path}`);
    }
  };

  return (
    <dialog ref={ref} className="export-dialog" aria-labelledby="export-title" onClose={onClose} onCancel={onClose}>
      <h2 id="export-title">Export</h2>

      <fieldset className="choice">
        <legend>Format</legend>
        {FORMATS.map((f) => (
          <label className="check" key={f.id}>
            <input
              type="radio"
              name="format"
              checked={format === f.id}
              onChange={() => {
                setFormat(f.id);
                setSaved(null);
              }}
            />
            <span>
              <strong>{f.title}</strong> <span className="hint">{f.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="choice">
        <legend>{format === "text" ? "Model" : "Models"}</legend>
        {snap.runs.map((r) => (
          <label className="check" key={r.id}>
            <input
              type={format === "text" ? "radio" : "checkbox"}
              name="model"
              checked={chosen.includes(r.id)}
              onChange={() => {
                toggleRun(r.id);
                setSaved(null);
              }}
            />
            {r.label}
          </label>
        ))}
      </fieldset>

      <fieldset className="choice">
        <legend>Text</legend>
        <label className="check">
          <input type="radio" name="version" checked={textVersion === "current"} onChange={() => setTextVersion("current")} />
          Current (with your edits)
        </label>
        <label className="check">
          <input type="radio" name="version" checked={textVersion === "original"} onChange={() => setTextVersion("original")} />
          Original (as the model wrote it)
        </label>
      </fieldset>

      {format === "csv" && (
        <label className="check">
          <input type="checkbox" checked={formulaSafe} onChange={(e) => setFormulaSafe(e.target.checked)} />
          <span title="Adds a ' before text starting with = + - or @, so Excel does not try to run it.">Protect against spreadsheet formulas</span>
        </label>
      )}

      <section aria-live="polite" className="export-preview">
        <h3>In the file</h3>
        {error && <p className="note error-note">{error}</p>}
        {preview?.problem && <p className="note error-note">{preview.problem}</p>}
        {preview && !preview.problem && (
          <>
            <ul className="plain">
              {preview.models.map((m) => (
                <li key={m.runId}>
                  <strong>{m.label}</strong>: {m.included} of {m.blocks} blocks have text
                  {m.edited > 0 && `, ${m.edited} edited by you`}
                  {m.outOfDate > 0 && `, ${m.outOfDate} out of date`}
                  {m.needsReview > 0 && `, ${m.needsReview} need review`}
                </li>
              ))}
            </ul>

            {needsPartial && (
              <div className="note">
                <p>
                  <strong>
                    {preview.gaps.length} block{preview.gaps.length === 1 ? " has" : "s have"} no translation:
                  </strong>
                </p>
                <ul className="plain">
                  {preview.gaps.slice(0, 8).map((g, i) => (
                    <li key={i}>
                      {g.label}, block {g.blockNumber} ({g.status})
                    </li>
                  ))}
                  {preview.gaps.length > 8 && <li>…and {preview.gaps.length - 8} more</li>}
                </ul>
                <label className="check">
                  <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
                  Export partial (marks the missing blocks)
                </label>
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="note">
                <p>
                  <strong>Included, but worth a look:</strong>
                </p>
                <ul className="plain">
                  {preview.warnings.slice(0, 8).map((w, i) => (
                    <li key={i}>
                      {w.label}, block {w.blockNumber}: {w.status}
                    </li>
                  ))}
                  {preview.warnings.length > 8 && <li>…and {preview.warnings.length - 8} more</li>}
                </ul>
              </div>
            )}

            {preview.excerpt && (
              <>
                <p className="hint">
                  {preview.fileName} · {(preview.bytes / 1024).toFixed(1)} KB
                </p>
                <pre className="excerpt" tabIndex={0} aria-label="Start of the file">
                  {preview.excerpt}
                </pre>
              </>
            )}
          </>
        )}
      </section>

      {saved && (
        <p className="note ok-note" role="status">
          ✓ {saved}
        </p>
      )}

      <div className="actions dialog-actions">
        <button className="primary" disabled={!canExport} onClick={() => void write()}>
          {busy ? "Saving…" : "Export…"}
        </button>
        <button onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
