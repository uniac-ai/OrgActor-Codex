import { createRoot } from "react-dom/client";
import { ConsoleControl } from "./control/console";
import "./styles.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<ConsoleControl />);
