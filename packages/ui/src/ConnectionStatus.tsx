import { Button, Flex, Text } from "@radix-ui/themes";
import type { Backend } from "@ltw/domain";
import type { useProvider } from "./useProvider";

/** One line at the bottom of the left panel: is the model server reachable? Click to check again. */
export function ConnectionStatus({ backend, provider, onSettings }: { backend: Backend; provider: ReturnType<typeof useProvider>; onSettings: () => void }) {
  if (backend === "practice") {
    return (
      <Flex align="center" gap="2" px="3" py="2" className="conn">
        <Text color="gray" size="1" aria-hidden="true">
          ○
        </Text>
        <Text size="1" color="gray">
          Practice mode
        </Text>
      </Flex>
    );
  }
  const { view, test, testing } = provider;
  const ok = test?.ok === true;
  const text = testing ? "Checking…" : ok ? `Connected · ${test!.models.length} model${test!.models.length === 1 ? "" : "s"}` : view?.problem ? "Server address problem" : "Not connected";
  return (
    <Flex align="center" gap="2" px="3" py="2" role="status" className="conn">
      <Text color={ok ? "green" : testing ? "gray" : "red"} size="1" aria-hidden="true">
        {ok ? "●" : "○"}
      </Text>
      <Text size="1" color="gray" truncate style={{ flex: 1 }} title={test?.message ?? view?.problem ?? ""}>
        {text}
      </Text>
      <Button variant="ghost" size="1" onClick={() => (ok || testing ? void provider.refresh() : onSettings())}>
        {ok || testing ? "Refresh" : "Fix"}
      </Button>
    </Flex>
  );
}
