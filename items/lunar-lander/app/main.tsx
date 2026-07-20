import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LunarLanderApp from "./index";

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><LunarLanderApp /></StrictMode>);
