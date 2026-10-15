# Local Translation Workbench

A desktop app for translating long fiction (Japanese to English first, other pairs are settings) with a local model, for example in LM Studio. You paste the text, the app cuts it into blocks, reads each block for names and speakers, and translates it one paragraph at a time with a knowledge base of names and notes feeding every request.

## How it works

1. **Source.** The text of a document is edited in the first column, with the number of each paragraph in the margin. There are no blocks: a document is its paragraphs.
2. **What was read.** The whole text is read once, with rules in code (no model): the words in it (names, places, terms) and who says each line of speech. You check them: each word has an English name, a note to the model, a kind and the attributes of that kind, and a use/ignore switch. Words you use enter the knowledge base when the text is translated. Each line has a speaker you can change, and the rules can fill in the lines that are not known.
3. **Translation.** The paragraphs are translated one after the other, each by its own request: the model gets only the glossary words, word notes and speaker notes of that paragraph, the paragraphs around it as far as the context has room (the ones before with their translations, the ones after so it knows where the story goes), and the paragraph. There is no block edge: the window rolls along the text. Because one paragraph is one request, each translated paragraph belongs to a known source paragraph. Each has its own box: edit it, translate it again, and the source follows the box you are in. Translating again carries on where it stopped; the whole text can be written again after a second look at what was read.
4. **Knowledge base.** Topics (characters, places, organizations, terms) are files with attributes and links, edited as text in a pane next to the workspace. The kinds of topic and their attributes are defined in a classes file.

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
