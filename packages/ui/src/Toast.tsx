import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";

export interface ToastInput {
  text: string;
  /** A button that takes the change back (or does the follow-up the message offers). */
  action?: { label: string; run: () => void };
}

const SHOWN_MS = 8000;

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined);

/** Tells the user what just happened, with a button to take it back; goes away by itself. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastInput | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);
  const show = useCallback((t: ToastInput) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(t);
    timer.current = setTimeout(() => setToast(null), SHOWN_MS);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Flex className="toast" align="center" gap="3" role="status">
          <Text size="2">{toast.text}</Text>
          {toast.action && (
            <Button
              size="1"
              variant="solid"
              onClick={() => {
                toast.action!.run();
                close();
              }}
            >
              {toast.action.label}
            </Button>
          )}
        </Flex>
      )}
    </ToastContext.Provider>
  );
}
