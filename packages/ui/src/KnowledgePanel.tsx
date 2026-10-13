import { KnowledgeEditor, KnowledgeSummary, KNOWLEDGE_HELP } from "./KnowledgeEditor";
import { NotesAssistant } from "./NotesAssistant";
import type { SetupState } from "./setup";

/**
 * Names, hints and notes for the whole project, as one text that is read as you type.
 * Each block only receives the lines that apply to its own text.
 */
export function KnowledgePanel({
  setup,
  passages,
  onKnowledge,
  assistant = true,
}: {
  setup: Pick<SetupState, "backend" | "sourceLanguage" | "targetLanguage" | "models" | "knowledge">;
  passages: readonly string[];
  onKnowledge: (text: string) => void;
  assistant?: boolean;
}) {
  return (
    <div className="kb-pane">
      <div className="kb-meta">
        <KnowledgeSummary text={setup.knowledge} />
        <span className="hint kb-help" title="Each block only receives the lines that apply to its own text.">
          {KNOWLEDGE_HELP}
        </span>
      </div>
      {assistant && <NotesAssistant setup={setup} passages={passages} knowledge={setup.knowledge} onKnowledge={onKnowledge} />}
      <KnowledgeEditor value={setup.knowledge} onChange={onKnowledge} />
    </div>
  );
}
