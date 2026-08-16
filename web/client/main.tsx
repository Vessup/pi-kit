import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { App } from "./app";
import { installAppViewportHeight } from "./app-viewport";

installAppViewportHeight();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
