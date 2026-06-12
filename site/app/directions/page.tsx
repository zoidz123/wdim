const directions = [
  {
    name: "01 / calm operating system",
    className: "directionGreenly",
    eyebrow: "agents for attention debt",
    title: "your daily catch-up, already sorted",
    body: "A clean B2B SaaS direction: light surface, confident product preview, and green highlights. Best if we want wdim to feel trustworthy and easy to adopt.",
    cta: "Join beta"
  },
  {
    name: "02 / editorial briefing",
    className: "directionEditorial",
    eyebrow: "what did i miss",
    title: "a dedicated guide for every inbox",
    body: "A more premium editorial direction using the serif as a hero voice. Best if we want the product to feel like a calm personal analyst, not another dashboard.",
    cta: "See the catch-up"
  },
  {
    name: "03 / playful desk",
    className: "directionStudio",
    eyebrow: "gmail · telegram · github · x",
    title: "stop checking five apps to learn one thing",
    body: "A minimal but more personality-forward direction with outlined modules and tags. Best if we want wdim to feel founder-built, memorable, and a little more human.",
    cta: "Start catching up"
  },
  {
    name: "04 / quiet command center",
    className: "directionCommand",
    eyebrow: "local-first mac app",
    title: "the signal layer for your day",
    body: "A darker, product-led direction closer to the app itself. Best if we want continuity from marketing page into the desktop product experience.",
    cta: "Try wdim"
  }
];

export default function DirectionsPage() {
  return (
    <main className="directionsPage">
      <nav className="directionsNav">
        <a className="brand" href="/">
          <span>wdim</span>
        </a>
        <a href="/">Current landing</a>
      </nav>

      <header className="directionsIntro">
        <p className="sectionKicker">landing directions</p>
        <h1>four ways wdim could feel</h1>
        <p>
          Same product story, different first impression. These are quick visual lanes inspired by the references:
          clean SaaS, editorial serif, playful framed UI, and dark command center.
        </p>
      </header>

      <div className="directionStack">
        {directions.map((direction) => (
          <section className={`direction ${direction.className}`} key={direction.name}>
            <div className="directionMeta">{direction.name}</div>
            <div className="directionHero">
              <div className="directionCopy">
                <p>{direction.eyebrow}</p>
                <h2>{direction.title}</h2>
                <span>{direction.body}</span>
                <button type="button">{direction.cta}</button>
              </div>
              <DirectionMockup />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function DirectionMockup() {
  return (
    <div className="directionMockup" aria-label="wdim preview">
      <div className="mockupTop">
        <strong>Found 18 items</strong>
        <span>Last scanned 6m ago</span>
      </div>
      <div className="mockupSources">
        <div>
          <span>Gmail</span>
          <strong>+2</strong>
        </div>
        <div>
          <span>Telegram</span>
          <strong>+6</strong>
        </div>
        <div>
          <span>X</span>
          <strong>+10</strong>
        </div>
      </div>
      <article>
        <span>Telegram</span>
        <h3>Partner thread needs a decision</h3>
        <p>Someone bumped the thread and asked for next steps. wdim pulled it out of the scroll.</p>
      </article>
      <article>
        <span>X</span>
        <h3>Market narrative is shifting</h3>
        <p>A post in your timeline flagged a trend worth catching up on before the next meeting.</p>
      </article>
    </div>
  );
}
