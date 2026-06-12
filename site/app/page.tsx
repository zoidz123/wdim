const integrations = [
  { name: "Gmail", logo: "/logos/gmail.svg" },
  { name: "Telegram", logo: "/logos/telegram.svg" },
  { name: "YouTube", logo: "/logos/youtube.svg" },
  { name: "X", logo: "/logos/x.svg" }
];

const betaDownloadHref = "https://download.wdim.app/releases/wdim-0.1.3-arm64.dmg?v=e66fc030";

const steps = [
  {
    title: "Connect your apps",
    body: "Add the inboxes, chats, channels, and feeds you usually check."
  },
  {
    title: "Let wdim check them",
    body: "Every hour, your agent scans for updates and filters the noise."
  },
  {
    title: "Read one briefing",
    body: "See what matters, open the source if needed, and get back to your day."
  }
];

export default function Home() {
  return (
    <main className="page">
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#">
          <img src="/wdim-icon.png" alt="" aria-hidden="true" />
          <span>wdim</span>
        </a>
        <a className="button" href={betaDownloadHref}>Download beta</a>
      </nav>

      <header className="hero">
        <section className="heroCopy" aria-labelledby="hero-title">
          <h1 id="hero-title">What did I miss?</h1>
          <p className="lede">
            One place to catch up while agents scan the sources you care about.
          </p>
          <div className="heroActions">
            <a className="button" href={betaDownloadHref}>Download beta</a>
            <a className="button secondary" href="#how">How it works</a>
          </div>
          <p className="availabilityNote">Beta download is for Apple Silicon macOS only.</p>
        </section>

        <figure className="heroImage">
          <img src="/wdim-app-hero.png" alt="wdim app showing important items grouped by source" />
        </figure>
      </header>

      <section className="supportedApps" aria-labelledby="supported-title">
        <p id="supported-title" className="supportedLabel">
          Currently supported integrations
        </p>
        <div className="appBadgeRow">
          {integrations.map((app) => (
            <div className="appBadge" key={app.name}>
              <span aria-hidden="true">
                <img src={app.logo} alt="" />
              </span>
              <strong>{app.name}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="section compact" id="how">
        <div className="sectionHeader center">
          <h2>Stop opening five apps to feel caught up.</h2>
          <p>
            wdim scans them every hour and shows what matters.
          </p>
        </div>
        <div className="steps">
          {steps.map((step, index) => (
            <article className="step" key={step.title}>
              <span>{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="privacyBand" aria-labelledby="privacy-title">
        <h2 id="privacy-title">Privacy-first by design</h2>
        <p>
          Tokens stay on your Mac, scans run in the desktop app, and wdim does not store your message content.
        </p>
      </section>

    </main>
  );
}
