import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { AdminApp } from './admin/AdminApp';

/**
 * Placeholder landing for the normal (non-admin) app. The user-facing dashboard,
 * search, portfolio and conglomerate pages arrive in later phases; this issue
 * (#5) builds only the admin area under `/admin/*`.
 */
function Landing() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#0b0e14] text-neutral-200">
      <section className="max-w-xl px-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">BetterTrack</h1>
        <p className="mt-3 text-neutral-400">
          Self-hosted stock watching, Conglomerates &amp; portfolio tracking.
        </p>
        <p className="mt-2 text-sm text-neutral-500">
          Foundation bootstrap — application features arrive in later phases.
        </p>
      </section>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </BrowserRouter>
  );
}
