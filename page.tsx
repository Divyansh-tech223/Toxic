export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-6 py-12 text-slate-100">
      <section className="w-full max-w-3xl rounded-3xl border border-cyan-400/30 bg-slate-900/80 p-10 shadow-[0_0_32px_rgba(0,210,255,0.18)] backdrop-blur">
        <p className="m-0 text-xs uppercase tracking-[0.16em] text-cyan-300/90">Platform status</p>
        <h1 className="mt-4 text-[clamp(1.8rem,4vw,3rem)] font-bold leading-tight text-cyan-100">
          Toxic Platform Core - Pipeline Active
        </h1>
        <p className="mt-4 max-w-2xl text-sm text-slate-300">
          This environment is operating in educational test mode with a stubbed data tier and
          active gateway routing pipeline for browser isolation and streaming diagnostics.
        </p>
      </section>
    </main>
  );
}
