import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { Page } from "./page"

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
