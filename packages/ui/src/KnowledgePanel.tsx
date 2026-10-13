import { KnowledgeTable } from "./KnowledgeTable";
import { NotesAssistant } from "./NotesAssistant";
import type { SetupState } from "./setup";

/**
 * Names, hints and notes for the whole project. Each block only receives the entries that apply to its own text.
 * A model can read the open text and suggest entries; they stay marked as suggested until you confirm them.
 */
export function KnowledgePanel({
  setup,
  passages,
  rev,
  documentTitle,
}: {
  setup: Pick<SetupState, "backend" | "sourceLanguage" | "targetLanguage" | "models">;
  passages: readonly string[];
  rev: number;
  documentTitle: string;
}) {
  return (
    <div className="kb-pane">
      <NotesAssistant setup={setup} passages={passages} documentTitle={documentTitle} />
      <KnowledgeTable rev={rev} />
    </div>
  );
}
