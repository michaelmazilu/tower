import { Component, Suspense, lazy, memo, useEffect, useState, type ReactNode } from "react";
import { OpsStatus, OpsView } from "./ops/OpsView";
import { useOps } from "./ops/useOps";
import { useSound } from "./shared/sound";

const LazyWorld = lazy(() => import("./world/WorldView"));
// The ops feed re-renders the shell twice a second; the world screen does not care.
const World = memo(({ sound }: { sound: boolean }) => <LazyWorld sound={sound} />);

const tabFromHash = () => (location.hash === "#world" ? "world" : "operations");

export function App() {
  const [tab, setTab] = useState(tabFromHash);
  const link = useOps();
  // Held above the screens and the run, so that a restart or a tab does not switch the sound off.
  const sound = useSound();

  useEffect(() => {
    const changed = () => setTab(tabFromHash());
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><i />TowerAI</div>
        <nav className="tabs">
          {(["operations", "world"] as const).map((id, i) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? "page" : undefined}>
              <b>{i + 1}</b>
              {id}
            </a>
          ))}
        </nav>
        {tab === "operations" ? <OpsStatus link={link} /> : <WorldStatus />}
      </header>
      <main className="screen">
        <Guard key={tab}>
          <Suspense fallback={<p className="wait">loading</p>}>
            {tab === "world" ? <World sound={sound.on && sound.ready} /> : <OpsView link={link} sound={sound} />}
          </Suspense>
        </Guard>
      </main>
    </div>
  );
}

function WorldStatus() {
  return (
    <div className="top-status">
      <div className="top-controller">
        <small>recorded replay</small>
        <p><em>simulated</em>each line is marked llm or rules</p>
      </div>
    </div>
  );
}

class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wait">
        <p>This screen stopped.</p>
        <button className="btn btn-red" onClick={() => location.reload()}><b>reload</b></button>
      </div>
    );
  }
}
