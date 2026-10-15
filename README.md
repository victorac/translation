# Local Translation Workbench

A desktop app for translating long fiction (Japanese to English first, other pairs are settings) with a local model, for example in LM Studio. You paste the text, the app cuts it into blocks, reads each block for names and speakers, and translates it one paragraph at a time with a knowledge base of names and notes feeding every request.

## How it works

1. **Source.** The text of a document is edited in the first column, with the number of each paragraph in the margin. There are no blocks: a document is its paragraphs.
2. **What was read.** The whole text is read once, with rules in code (no model): the words in it (names, places, terms) and who says each line of speech. What the rules find is only suggested: a dictionary reading of a name written with kanji (none for a katakana name, where it would only spell out sounds), a gender from a pronoun, a speaker from the narration or from two people taking turns. A suggested English name shows in grey in the word's own field: write over it to change the suggestion (Enter keeps it as a suggestion), the check mark confirms it, and clearing the field drops it. Other suggestions have a Confirm button. A word's menu can ask the model for a suggestion from the translation.
3. **Translation.** The paragraphs are translated one after the other, each by its own request: the model gets the glossary words you confirmed, word notes and confirmed speakers of that paragraph and, for a name that is not confirmed yet, its suggested English name, told as how the name sounds and not as a spelling it must use (what you wrote as a suggestion, or the dictionary's guess for a name written with kanji, which the model cannot read; for a name in katakana the dictionary only spells out sounds, so the model is left to spell it itself unless you write a suggestion; edit a suggestion in the word's row, or clear it to send nothing), the paragraphs around it as far as the context has room (the ones before with their translations, the ones after so it knows where the story goes), and the paragraph. There is no block edge: the window rolls along the text. Because one paragraph is one request, each translated paragraph belongs to a known source paragraph. Each can be edited in place or translated again.
4. **Suggestions from the translation.** When the translation is written, the model reads it with short questions, each with an answer that code can check: how each name was written (words copied from the translation), a gender or another attribute chosen from a list (a letter, checked against the pronouns), and who says each line (a letter from the people nearby, never someone the line is spoken to). An answer that fails its check is thrown away. The results are suggestions in the middle pane.
5. **Review and run again.** You confirm or change what was read, then Translate again with the confirmed glossary and notes, or translate one paragraph again.
6. **Knowledge base.** Topics (characters, places, organizations, terms) have attributes and links. They open in a drawer over the workspace: a searchable list (with checkboxes to confirm or delete several at once) and, for the chosen topic, a form, or its file as text. The kinds of topic and their attributes are defined in a classes file, opened from the drawer's header. A word is added to the glossary by selecting it in the source, and removed from its menu; removing and deleting can be undone for a few seconds.

The **Log** button in the toolbar lists the errors, warnings (such as a paragraph that left out a glossary name) and notices of the session, newest first, with a count of new problems on the button; it can be copied or cleared. It is kept for the session only.

Checks that can be made in code are made in code: a glossary name that a paragraph should use and does not is asked for again, an answer of several paragraphs is asked for again, and a translation that comes back unchanged is asked for again with the rejected version shown.

## Layout

- `packages/domain` rules and types with no Node in them (so the window can use them): reading names and speakers, the request for a paragraph, the topic files, the project file.
- `packages/providers` the OpenAI-compatible adapter (LM Studio) with streaming and plain error messages.
- `packages/desktop` the background process: the workspace service, project files with a recovery copy, the connection settings, and the Electron shell.
- `packages/ui` the window: React with Radix Themes and CodeMirror.

## Working on it

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev        # the Electron app
pnpm dev:web    # the window in a browser, with a stand-in background process (for quick checks)
```

A project is saved as `.ltw.json`: plain JSON with the documents' text, the work on each document, the knowledge base and the settings. It never contains API keys.
