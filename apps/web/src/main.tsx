import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { api } from "./api.js";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
