import { CustomerApp } from "../app/CustomerApp.tsx";
import { Highlights } from "../components/demo/Highlights.tsx";
import "./stage.css";

export function Stage() {
  return (
    <div className="stage">
      <section className="stage-phone" aria-label="Customer app">
        <CustomerApp framed />
      </section>
      <section className="stage-console" aria-label="Demo">
        <Highlights />
      </section>
    </div>
  );
}
