import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import { App } from "./App";
import { ToastProvider } from "./Toast";
import "./styles.css";

/** Light or dark, as the system says, and following it when it changes. */
function useAppearance(): "light" | "dark" {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const change = () => setDark(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  return dark ? "dark" : "light";
}

function Root() {
  const appearance = useAppearance();
  return (
    <Theme appearance={appearance} accentColor="indigo" grayColor="slate" radius="medium" panelBackground="solid" style={{ height: "100%" }}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
