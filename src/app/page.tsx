import Workspace from "@/components/workspace";

export default function Home() {
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <p className="eyebrow">Invoice resolution</p>
        <h1>Invoice workspace</h1>
        <p className="intro">A clear view of what is owed and what has been paid.</p>
      </header>
      <Workspace />
    </main>
  );
}
