import "../../vendor/chimera/src/ui/styles.css";
import { initChimera } from "../../vendor/chimera/src/wasm/chimera.ts";
import { createRoot } from "react-dom/client";
try {
  await initChimera("/chimera.wasm");
  const { App } = await import("./App.tsx");
  createRoot(document.getElementById("root")!).render(<App />);
} catch (error) {
  document.getElementById("root")!.textContent = `Engine failed to load: ${error}`;
}
