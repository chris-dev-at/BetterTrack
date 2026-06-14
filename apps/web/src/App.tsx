export default function App() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'system-ui, sans-serif',
        background: '#0b0e14',
        color: '#e6e6e6',
      }}
    >
      <section style={{ textAlign: 'center', maxWidth: '36rem', padding: '2rem' }}>
        <h1 style={{ margin: 0, fontSize: '2.5rem' }}>BetterTrack</h1>
        <p style={{ opacity: 0.8 }}>
          Self-hosted stock watching, Conglomerates &amp; portfolio tracking.
        </p>
        <p style={{ opacity: 0.55, fontSize: '0.9rem' }}>
          Foundation bootstrap — application features arrive in later phases.
        </p>
      </section>
    </main>
  );
}
