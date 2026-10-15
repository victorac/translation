import { useEffect, useState } from "react";
import { Button, Callout, Dialog, Flex, SegmentedControl, Text } from "@radix-ui/themes";
import type { Work } from "@ltw/domain";
import { api } from "./api";

type What = "translation" | "both";
type Kind = "txt" | "md";

/** The text of the export: the translation of every paragraph, or each paragraph's source with its translation under it. */
export function exportText(work: Work, what: What, kind: Kind): string {
  const parts = work.paragraphs.map((p) => {
    const translation = p.translation.trim() === "" ? "[not translated yet]" : p.translation.trim();
    if (what === "translation") return translation;
    return kind === "md" ? `> ${p.text}\n\n${translation}` : `${p.text}\n\n${translation}`;
  });
  return `${parts.join(what === "both" && kind === "txt" ? "\n\n----\n\n" : "\n\n")}\n`;
}

/** Saves the translation as a text file. */
export function ExportDialog({ title, onClose }: { title: string; onClose: () => void }) {
  const [state, setState] = useState<Work | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [what, setWhat] = useState<What>("translation");
  const [kind, setKind] = useState<Kind>("txt");

  useEffect(() => {
    void api.invoke("work.get").then((r) => {
      if (r.ok) setState(r.value);
      setLoaded(true);
    });
  }, []);

  const total = state?.paragraphs.length ?? 0;
  const translated = state?.paragraphs.filter((p) => p.translation.trim() !== "").length ?? 0;

  const save = () => {
    if (!state) return;
    const blob = new Blob([exportText(state, what, kind)], { type: kind === "md" ? "text/markdown" : "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${title.replace(/[\\/:*?"<>|]+/g, "-") || "translation"}.${kind}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth="28rem">
        <Dialog.Title>Export translation</Dialog.Title>
        {!loaded ? (
          <Text size="2" color="gray">
            Loading…
          </Text>
        ) : total === 0 ? (
          <Dialog.Description size="2">There is nothing to export yet. Paste the source text and translate it first.</Dialog.Description>
        ) : (
          <Flex direction="column" gap="4" mt="3">
            <Dialog.Description size="2" color="gray">
              {translated} of {total} paragraphs are translated.
            </Dialog.Description>
            {translated < total && (
              <Callout.Root color="amber" size="1">
                <Callout.Text>Paragraphs that are not translated yet are marked “[not translated yet]” in the file.</Callout.Text>
              </Callout.Root>
            )}
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                What to include
              </Text>
              <SegmentedControl.Root value={what} onValueChange={(v) => setWhat(v as What)}>
                <SegmentedControl.Item value="translation">Translation only</SegmentedControl.Item>
                <SegmentedControl.Item value="both">Source and translation</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                File type
              </Text>
              <SegmentedControl.Root value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SegmentedControl.Item value="txt">Plain text (.txt)</SegmentedControl.Item>
                <SegmentedControl.Item value="md">Markdown (.md)</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>
          </Flex>
        )}
        <Flex gap="2" justify="end" mt="5">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </Dialog.Close>
          <Button onClick={save} disabled={!state || total === 0}>
            Save file
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
