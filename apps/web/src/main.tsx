import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "zod";

import { api } from "./api.js";
import { App } from "./App.js";
import "./styles.css";

// Game clients validate with Zod (02 §3), whose compiled parsers need `new Function`. The page's CSP
// forbids it (08 §3: no `unsafe-eval`), and even the probe for it is reported as a violation, so
// every Zod in the page is told not to compile. One bundle holds one copy, so this reaches the
// clients' too.
config({ jitless: true });

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
