import { Component, Suspense, lazy, memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { OpsStatus, OpsView } from "./ops/OpsView";
import { useOps } from "./ops/useOps";
import { useSound } from "./shared/sound";

const LazyCockpit = lazy(() => import("./cockpit/CockpitView"));
const LazyWorld = lazy(() => import("./world/WorldView"));
// The ops feed re-renders the shell twice a second; the other screens do not care.
const Cockpit = memo(() => <LazyCockpit />);
const World = memo(({ sound, onSound }: { sound: boolean; onSound(): void }) => <LazyWorld sound={sound} onSound={onSound} />);

const TABS = ["cockpit", "operations", "world"] as const;
const tabFromHash = () => TABS.find((id) => location.hash === `#${id}`) ?? "cockpit";

export function App() {
  const [tab, setTab] = useState(tabFromHash);
  const link = useOps();
  // Held above the screens and the run, so that a restart or a tab does not switch the sound off.
  const sound = useSound();
  const press = useRef(sound.press);
  press.current = sound.press;
  const pressSound = useCallback(() => press.current(), []);

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
          {TABS.map((id, i) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? "page" : undefined}>
              <b>{i + 1}</b>
              {id}
            </a>
          ))}
        </nav>
        {tab === "operations" ? <OpsStatus link={link} /> : tab === "world" ? <WorldStatus /> : <CockpitStatus />}
      </header>
      <main className="screen">
        <Guard key={tab}>
          <Suspense fallback={<p className="wait">loading</p>}>
            {tab === "cockpit" && <Cockpit />}
            {tab === "operations" && <OpsView link={link} sound={sound} />}
            {tab === "world" && <World sound={sound.on && sound.ready} onSound={pressSound} />}
          </Suspense>
        </Guard>
      </main>
    </div>
  );
}

function CockpitStatus() {
  return (
    <div className="top-status">
      <div className="top-controller">
        <small>the pilot&apos;s seat at Toronto Pearson</small>
        <p><em>simulated</em>not for real flying</p>
      </div>
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
