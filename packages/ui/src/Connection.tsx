import { useState } from "react";
import { Badge, Button, Callout, Checkbox, Flex, SegmentedControl, Text, TextField } from "@radix-ui/themes";
import type { Backend } from "@ltw/domain";
import type { useProvider } from "./useProvider";

const isLocalHost = (address: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname);
  } catch {
    return true; // not a valid address yet: the background process explains the problem
  }
};

/** The model server: address, optional key, and a test that lists its models. */
export function Connection({
  backend,
  onBackend,
  provider,
  onAddModel,
  haveModel,
}: {
  backend: Backend;
  onBackend: (b: Backend) => void;
  provider: ReturnType<typeof useProvider>;
  onAddModel: (name: string) => void;
  haveModel: (name: string) => boolean;
}) {
  const view = provider.view;
  const [address, setAddress] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [allowRemote, setAllowRemote] = useState<boolean | null>(null);

  return (
    <Flex direction="column" gap="4">
      <SegmentedControl.Root value={backend} onValueChange={(v) => onBackend(v as Backend)} aria-label="Translator">
        <SegmentedControl.Item value="provider">LM Studio</SegmentedControl.Item>
        <SegmentedControl.Item value="practice">Practice</SegmentedControl.Item>
      </SegmentedControl.Root>

      {backend === "practice" ? (
        <Text size="2" color="gray">
          A pretend translator for trying the app. It writes a placeholder and nothing leaves this computer.
        </Text>
      ) : !view ? (
        <Text size="2" color="gray">
          Loading…
        </Text>
      ) : (
        (() => {
          const shown = address ?? view.baseUrl;
          const local = isLocalHost(shown);
          const approved = allowRemote ?? view.remoteAllowed;
          const test = () => void provider.saveAndTest({ baseUrl: shown, allowRemote: local ? false : approved, ...(key !== null ? { apiKey: key } : {}) });
          return (
            <>
              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  Address
                </Text>
                <TextField.Root
                  size="2"
                  value={shown}
                  spellCheck={false}
                  onChange={(e) => {
                    setAddress(e.target.value);
                    provider.clearTest();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && test()}
                />
              </Flex>
              {!local && (
                <Callout.Root color="amber" size="1">
                  <Callout.Text>
                    <Text as="label" size="2">
                      <Flex gap="2" align="start">
                        <Checkbox checked={approved} onCheckedChange={(c) => setAllowRemote(c === true)} />
                        <span>
                          This is not your computer. Allow sending text to{" "}
                          <strong>
                            {(() => {
                              try {
                                return new URL(shown).host;
                              } catch {
                                return shown;
                              }
                            })()}
                          </strong>
                          .
                        </span>
                      </Flex>
                    </Text>
                  </Callout.Text>
                </Callout.Root>
              )}
              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  API key{" "}
                  <Text size="1" color="gray" weight="regular">
                    optional
                  </Text>
                </Text>
                <TextField.Root size="2" type="password" autoComplete="off" placeholder={view.hasApiKey && key === null ? "Saved. Type to replace." : ""} value={key ?? ""} onChange={(e) => setKey(e.target.value)} />
                {view.hasApiKey && key === null && (
                  <Button variant="ghost" size="1" style={{ alignSelf: "flex-start" }} onClick={() => setKey("")}>
                    Remove saved key
                  </Button>
                )}
              </Flex>
              <Flex>
                <Button onClick={test} disabled={provider.testing}>
                  {provider.testing ? "Testing…" : "Test connection"}
                </Button>
              </Flex>
              <Flex direction="column" gap="2" role="status" aria-live="polite">
                {provider.saveError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{provider.saveError}</Callout.Text>
                  </Callout.Root>
                )}
                {provider.test && (
                  <Callout.Root color={provider.test.ok ? "green" : "red"} size="1">
                    <Callout.Text>{provider.test.message}</Callout.Text>
                  </Callout.Root>
                )}
                {view.problem && !provider.test && !provider.saveError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{view.problem}</Callout.Text>
                  </Callout.Root>
                )}
              </Flex>
              {provider.test?.ok && provider.test.models.length > 0 && (
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">
                    Models on the server (listed is not loaded). Click to add:
                  </Text>
                  <Flex wrap="wrap" gap="1">
                    {provider.test.models.map((id) => (
                      <Button key={id} size="1" variant="soft" color="gray" onClick={() => onAddModel(id)} disabled={haveModel(id)}>
                        {haveModel(id) ? "✓" : "+"} {id}
                      </Button>
                    ))}
                  </Flex>
                </Flex>
              )}
              {view.hasApiKey && key !== null && key === "" && <Badge color="amber">The saved key will be removed</Badge>}
            </>
          );
        })()
      )}
    </Flex>
  );
}
