import { App } from "./App"
import { Footer } from "./footer"

/** The whole page: the check, then where this copy comes from (outside main, as the page's footer). */
export function Page() {
  return (
    <>
      <App />
      <Footer />
    </>
  )
}
