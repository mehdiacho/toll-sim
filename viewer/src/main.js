import "./style.css";
import { mountLanding } from "./landing.js";

// Hash router: #/ is the landing page, #/live is the 3D view.
const app = document.getElementById("app");
let unmount = null;
let current = null;

async function route() {
  const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
  const page = path.startsWith("/live") ? "live" : "landing";
  if (page === current) return;
  current = page;
  if (unmount) {
    unmount();
    unmount = null;
  }
  document.body.dataset.page = page;
  window.scrollTo(0, 0);
  if (page === "live") {
    document.title = "Live view · A1 Toll Simulator";
    const { mountViewer } = await import("./viewer.js");
    if (current !== "live") return;
    unmount = await mountViewer(app);
  } else {
    document.title = "A1 Toll Simulator";
    unmount = mountLanding(app);
  }
}

window.addEventListener("hashchange", route);
route();
