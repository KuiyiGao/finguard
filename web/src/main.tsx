import "./styles/base.css"; // first, so screen styles can override shared ones
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

const CustomerApp = lazy(() => import("./app/CustomerApp.tsx").then((m) => ({ default: m.CustomerApp })));
const Console = lazy(() => import("./console/Console.tsx").then((m) => ({ default: m.Console })));
const Stage = lazy(() => import("./stage/Stage.tsx").then((m) => ({ default: m.Stage })));
const Gallery = lazy(() => import("./gallery/Gallery.tsx").then((m) => ({ default: m.Gallery })));
const Desk = lazy(() => import("./desk/Desk.tsx").then((m) => ({ default: m.Desk })));

function Route() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/app") return <CustomerApp />;
  if (path === "/console") return <Console />;
  if (path === "/gallery") return <Gallery />;
  if (path === "/desk") return <Desk />;
  return <Stage />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Route />
    </Suspense>
  </StrictMode>,
);
